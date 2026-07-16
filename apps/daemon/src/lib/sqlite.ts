// node:sqlite 适配器 —— 顶替 better-sqlite3，去掉唯一的 native 依赖。
//
// 为什么存在：better-sqlite3 是 daemon 唯一的 native 模块（.node 死绑
// NODE_MODULE_VERSION）。为了让 daemon 跑在 Electron 自带的 node 上（从而不再
// 打包一份独立的 node-runtime，安装包每平台省 ~120MB），必须甩掉这个 native 依赖。
// 实测结论（2026-07-15）：
//   1. Electron 43 的内嵌 node（ABI 148）加载 CI 编的 .node（ABI 137）→ ERR_DLOPEN_FAILED。
//   2. 把 better-sqlite3 12.10.0 重编到 Electron 43 → 编不过（V8 15 给 External::New
//      加了必填 ExternalPointerTypeTag，源码是老 V8 两参 API）。
//   3. node:sqlite（Node 24 内置、Electron 43 无标志可用）支持 daemon 用到的全部
//      SQLite 特性：WAL、外键级联、窗口函数、CTE、upsert、事务、PRAGMA table_info、
//      VACUUM。且能直接打开老 better-sqlite3 写的 app.sqlite（标准 SQLite 格式，
//      无需数据迁移）。
//
// 覆盖 daemon 实测用到的全部接口面（grep 出来的，见落地记录）：
//   db:   new Database(file) / .prepare() / .exec() / .pragma() / .transaction() / .close()
//   stmt: .get() / .all() / .run()
// daemon **未**用到、故不实现：.iterate/.pluck/.raw/.columns/.function/.aggregate/
//   .backup/.loadExtension/.serialize。将来若有人用到，typecheck 会当场报缺方法。
//
// 类型形状刻意复刻 better-sqlite3 的 `Database.Database`（class + 同名 namespace 成员），
// 这样 27 处 `import type Database from '...'; type Db = Database.Database` 一字不改。

import { DatabaseSync, type StatementSync } from 'node:sqlite';

// better-sqlite3 的 .run() 返回 { changes, lastInsertRowid }，二者是 number。
// node:sqlite 的 run() 也返回同名字段，但在大整数时可能是 bigint；daemon 代码按
// number 处理（如 result.changes > 0），统一归一成 number。
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

function toNumber(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** 复刻 better-sqlite3 的 Statement（仅 daemon 用到的 get/all/run）。 */
export interface Statement<BindParameters extends unknown[] = unknown[]> {
  get(...params: BindParameters): unknown;
  all(...params: BindParameters): unknown[];
  run(...params: BindParameters): RunResult;
}

class StatementImpl implements Statement {
  readonly #stmt: StatementSync;
  constructor(stmt: StatementSync) {
    this.#stmt = stmt;
  }
  get(...params: unknown[]): unknown {
    // better-sqlite3 无结果返回 undefined；node:sqlite 同样返回 undefined。
    const row = this.#stmt.get(...(params as never[]));
    return row === undefined || row === null ? undefined : row;
  }
  all(...params: unknown[]): unknown[] {
    return this.#stmt.all(...(params as never[])) as unknown[];
  }
  run(...params: unknown[]): RunResult {
    const r = this.#stmt.run(...(params as never[]));
    return { changes: toNumber(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
}

/** db.transaction(fn) 返回的可调用事务函数（保留 better-sqlite3 的调用形态）。 */
export type Transaction<F extends (...args: never[]) => unknown = (...args: never[]) => unknown> = F;

// class 直接叫 Database，再用同名 namespace 声明合并（下方）暴露 Database.Database
// 等成员类型 —— 这正是 better-sqlite3 .d.ts 里 `export = Database` 的形状，让 27 处
// `import Database from '...'; type Db = Database.Database` 一字不改。
class Database {
  readonly #db: DatabaseSync;
  #txDepth = 0;

  constructor(filename: string, _options?: unknown) {
    // daemon 只用裸 new Database(file)，忽略 options。
    this.#db = new DatabaseSync(filename);
  }

  prepare<BindParameters extends unknown[] = unknown[]>(
    sql: string,
  ): Statement<BindParameters> {
    return new StatementImpl(this.#db.prepare(sql)) as unknown as Statement<BindParameters>;
  }

  exec(sql: string): this {
    this.#db.exec(sql);
    return this;
  }

  // better-sqlite3 的 .pragma(str, opts?) 有三种语义（daemon 全都用到）：
  //   1. 'journal_mode = WAL'（赋值，含 '='）→ 照跑，调用处忽略返回值。
  //   2. ('user_version', { simple: true }) → 返回首行首列标量。
  //   3. 'foreign_key_check' / 任意查询型 → 返回行数组。
  pragma(source: string, options?: { simple?: boolean }): unknown {
    const rows = this.#db.prepare(`PRAGMA ${source}`).all() as Array<Record<string, unknown>>;
    if (options?.simple === true) {
      const first = rows[0];
      if (!first) return undefined;
      const keys = Object.keys(first);
      return keys.length ? first[keys[0]!] : undefined;
    }
    return rows;
  }

  // better-sqlite3 的 db.transaction(fn) 返回「调用即在事务里跑 fn」的函数，支持嵌套
  // （嵌套用 savepoint）。daemon 用到 3 处，均最外层一层；这里 BEGIN/COMMIT 模拟，
  // 出错 ROLLBACK 并重抛，嵌套用 SAVEPOINT 兜底。
  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F> {
    const self = this;
    const wrapped = function (this: unknown, ...args: never[]): unknown {
      const nested = self.#txDepth > 0;
      const sp = `sp_${self.#txDepth}`;
      self.#txDepth++;
      if (nested) self.#db.exec(`SAVEPOINT ${sp}`);
      else self.#db.exec('BEGIN');
      try {
        const result = fn.apply(this, args);
        if (nested) self.#db.exec(`RELEASE ${sp}`);
        else self.#db.exec('COMMIT');
        return result;
      } catch (e) {
        if (nested) self.#db.exec(`ROLLBACK TO ${sp}`);
        else self.#db.exec('ROLLBACK');
        throw e;
      } finally {
        self.#txDepth--;
      }
    };
    return wrapped as Transaction<F>;
  }

  close(): void {
    // better-sqlite3 的 .close() 对已关闭的库是幂等的（不抛）；node:sqlite 的
    // DatabaseSync.close() 在已关闭时抛 'database is not open'。db.ts 的
    // closeDatabase()→openDatabase() 切库路径会对可能已关的库再 close 一次，
    // 依赖这个幂等性。用 isOpen 守卫（不可用则吞该特定错误）复刻幂等语义。
    const maybeOpen = (this.#db as unknown as { isOpen?: boolean }).isOpen;
    if (maybeOpen === false) return;
    try {
      this.#db.close();
    } catch (e) {
      if (e instanceof Error && /not open/i.test(e.message)) return;
      throw e;
    }
  }
}

// ---- 类型形状：复刻 better-sqlite3 的 `Database.Database` ----
// 同名 namespace 与 class Database 声明合并，暴露成员类型 Database.Database（=实例
// 类型）、Database.Statement、Database.Transaction、Database.RunResult。
// eslint 未启用；命名空间合并是复刻 better-sqlite3 .d.ts 的必要手段。
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Database {
  export type Database = InstanceType<typeof DatabaseClass>;
  export type Statement<B extends unknown[] = unknown[]> = StatementType<B>;
  export type Transaction<F extends (...args: never[]) => unknown = (...args: never[]) => unknown> =
    TransactionType<F>;
  export type RunResult = RunResultType;
}

// 内部别名，供 namespace 引用（namespace 里不能直接引用被合并的 class 自身作类型）。
type StatementType<B extends unknown[] = unknown[]> = Statement<B>;
type TransactionType<F extends (...args: never[]) => unknown = (...args: never[]) => unknown> =
  Transaction<F>;
type RunResultType = RunResult;
const DatabaseClass = Database;

// 具名类型导出：让 inline import 类型 `import('./sqlite.js').Database`（trust.ts 用）
// 也能解析到实例类型。default import 的 `Database.Database` 走上面的 namespace 合并；
// 两条路都指向同一个实例类型。
export type { DatabaseImpl as Database };
type DatabaseImpl = InstanceType<typeof DatabaseClass>;

export default Database;
