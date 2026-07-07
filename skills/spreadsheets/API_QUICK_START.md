# openpyxl Quick Reference (Python)

Target: openpyxl >= 3.1 in the skill venv (`$SHEETS_PY`, see SKILL.md bootstrap).
Run scripts as `"$SHEETS_PY" build_workbook.py`. This file is the API surface for
this skill — read it fully once per session, then consult sections as needed.

## Required Imports + Startup

Create a new workbook:
```python
from openpyxl import Workbook

wb = Workbook()
ws = wb.active
ws.title = "Inputs"
data = wb.create_sheet("Data")        # appended; create_sheet("X", 0) to insert first
```

Open an existing workbook (two views — see Gotchas #1/#2):
```python
from openpyxl import load_workbook

wb  = load_workbook("input.xlsx")                  # formulas view — the one you EDIT and SAVE
wbv = load_workbook("input.xlsx", data_only=True)  # cached-values view — READ ONLY, never save
```

Import CSV/TSV — clean with pandas, then write rows:
```python
import pandas as pd
df = pd.read_csv("input.csv")          # sep="\t" for TSV; dtype=str to protect IDs/ZIP codes
ws.append(list(df.columns))
for row in df.itertuples(index=False):
    ws.append(list(row))
```

Save (always last; target must not be open in Excel):
```python
wb.save("/absolute/path/营收模型.xlsx")
```

## Build Patterns
- Write cells via `ws["A1"] = value`, `ws.cell(row=2, column=3, value=...)` (1-based), or `ws.append([...])` for full rows. For blocks, loop `ws.iter_rows(min_row=..., max_row=..., min_col=..., max_col=...)` or nested `ws.cell(...)`.
- Formulas are plain strings: `ws["D2"] = "=C2/B2"`. There is no fillDown — generate the formula per row in the loop, adjusting relative references (f-strings: `f"=C{r}/B{r}"`).
- Dates: write real `datetime.date`/`datetime.datetime` objects and set an explicit `number_format` (e.g. `"yyyy-mm-dd"`), never preformatted strings.
- Values must be `str | int | float | bool | None | datetime` — no lists/dicts in cells.
- Create every worksheet referenced by formulas before saving; openpyxl won't validate, but Excel shows `#REF!` on open.
- A string starting with `=` is stored as a formula. For literal text that begins with `=` (formula descriptions, examples), set the type explicitly after assignment:
  ```python
  c = ws["B2"]; c.value = "=C2*D2 （示例，非公式）"; c.data_type = "s"
  ```

## Conventions
- Cell addressing: A1 notation for `ws["A1"]` / `merge_cells` / chart anchors; 1-based `(row, column)` ints for `ws.cell(...)` and `Reference(...)`.
- Colors: `"RRGGBB"` or `"AARRGGBB"` hex WITHOUT `#` (`Font(color="FFFFFF")`, `PatternFill(start_color="0F766E")`).
- Column width `ws.column_dimensions["A"].width` is in Excel character units (~7px each); row height `ws.row_dimensions[1].height` is in points.
- Chart size `chart.width`/`chart.height` is in centimetres.

## Reading existing/imported workbooks
```python
wb = load_workbook("book.xlsx")
print(wb.sheetnames)
ws = wb["Dashboard"]
print(ws.calculate_dimension(), ws.max_row, ws.max_column)   # max_* can overshoot, see Gotchas

for row in ws.iter_rows(min_row=1, max_row=20, max_col=8):
    for c in row:
        if c.value is not None:
            print(c.coordinate, repr(c.value), c.number_format)

# Cached results of formulas (needs the file to have been saved by Excel at least once):
wbv = load_workbook("book.xlsx", data_only=True)
print(wbv["Dashboard"]["D2"].value)      # None if no cached value exists
```
- Inspect styling before editing a formatted workbook: `c.font`, `c.fill`, `c.border`, `c.alignment`, `c.number_format`, `ws.merged_cells.ranges`, `ws.column_dimensions["A"].width`.
- Very large files: `load_workbook(path, read_only=True)` streams cells (no styles edit); `Workbook(write_only=True)` streams writes (append-only).

## Formatting
```python
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment

header_font   = Font(bold=True, color="FFFFFF", size=11)
header_fill   = PatternFill(fill_type="solid", start_color="0F766E")
thin          = Side(style="thin", color="D9D9D9")          # styles: thin/medium/thick/dashed/dotted/double
box           = Border(left=thin, right=thin, top=thin, bottom=thin)
center_wrap   = Alignment(horizontal="center", vertical="center", wrap_text=True)

for c in ws["A1:D1"][0]:
    c.font = header_font; c.fill = header_fill; c.border = box; c.alignment = center_wrap

ws["B2"].number_format = '"$"#,##0'
ws["D2"].number_format = "0.0%"
ws.column_dimensions["A"].width = 18
ws.row_dimensions[1].height = 24
ws.sheet_view.showGridLines = False       # hide gridlines when explicit fills/borders define structure
```
- **Styles apply per cell.** `ws["A1:D1"]` returns a tuple of row-tuples — loop it; assigning `.font` on the tuple raises. Helper for a range:
  ```python
  def style_range(ws, ref, **attrs):
      for row in ws[ref]:
          for c in row:
              for k, v in attrs.items(): setattr(c, k, v)
  ```
- There is no autofit in openpyxl. Approximate: width ≈ `max(len(str(v)) for v in column) + 2`, capped (e.g. 60); set explicitly.
- Reusable styles: `from openpyxl.styles import NamedStyle`, `wb.add_named_style(style)`, then `c.style = "header"`.

## Merging cells
```python
ws.merge_cells("A1:C1")       # write the value to the TOP-LEFT cell only
ws["A1"] = "Q3 业绩总览"
ws.unmerge_cells("A1:C1")
```
Merged non-top-left cells are read-only `MergedCell` objects — writing to them raises. Never merge inside calculation areas.

## Freeze panes / filters
```python
ws.freeze_panes = "A2"        # freeze row 1;  "B2" freezes row 1 + column A;  None to unfreeze
ws.auto_filter.ref = "A1:H200"
```

## Tables
```python
from openpyxl.worksheet.table import Table, TableStyleInfo

tab = Table(displayName="TasksTable", ref="A1:H200")     # ref INCLUDES the header row
tab.tableStyleInfo = TableStyleInfo(name="TableStyleMedium9", showRowStripes=True)
ws.add_table(tab)
```
- `displayName` must be unique in the workbook, no spaces.
- Tables must not overlap; check existing `ws.tables` before adding on an imported workbook.
- Write the header/data cells yourself first — Table only declares the range.

## Data Validation
```python
from openpyxl.worksheet.datavalidation import DataValidation

dv = DataValidation(type="list", formula1='"未开始,进行中,已完成"', allow_blank=True)
ws.add_data_validation(dv)
dv.add("B2:B100")

whole = DataValidation(type="whole", operator="between", formula1=1, formula2=10)
ws.add_data_validation(whole); whole.add("C2:C100")
```
- List from a range: same-sheet `formula1="$Z$2:$Z$5"` is safest; for cross-sheet sources use a defined name.

## Conditional formatting
```python
from openpyxl.formatting.rule import (
    ColorScaleRule, DataBarRule, IconSetRule, CellIsRule, FormulaRule)
from openpyxl.styles import PatternFill, Font

ws.conditional_formatting.add("B2:J10", ColorScaleRule(
    start_type="min", start_color="2563EB",
    mid_type="percentile", mid_value=50, mid_color="FDE047",
    end_type="max", end_color="DC2626"))

red = PatternFill(fill_type="solid", start_color="FDE8E8")
ws.conditional_formatting.add("D2:D100",
    CellIsRule(operator="greaterThan", formula=["100"], fill=red))   # operators: greaterThan/lessThan/between/equal/...

ws.conditional_formatting.add("A2:F100",
    FormulaRule(formula=['$E2="逾期"'], fill=red, font=Font(color="B91C1C")))

ws.conditional_formatting.add("G2:G100",
    DataBarRule(start_type="min", end_type="max", color="638EC6", showValue=True))

ws.conditional_formatting.add("H2:H100",
    IconSetRule(icon_style="3TrafficLights1", type="percent", values=[0, 33, 67]))
```
- `FormulaRule`/`CellIsRule` relative references are evaluated from the range's top-left cell — anchor columns with `$` exactly as you would in Excel.
- Icon styles: `3Arrows`, `3TrafficLights1`, `3Symbols`, `4Arrows`, `5Rating`, etc.
- After adding rows to a table, re-add or extend the rule range — it does not grow automatically.

## Charts
Supported natively: **bar/column, line, pie, doughnut, scatter, area, bubble, radar, stock**.
NOT supported (modern chartEx types): treemap, sunburst, histogram, box&whisker, waterfall, funnel, map — pick the closest classic type instead (see charts.md).

```python
from openpyxl.chart import BarChart, LineChart, PieChart, Reference

chart = LineChart()
chart.title = "Revenue Trend"
chart.style = 12                                   # built-in style 1–48
chart.y_axis.numFmt = '"$"#,##0'                   # set axis number formats explicitly
chart.x_axis.title = "Month"; chart.y_axis.title = "Revenue"
chart.x_axis.delete = False; chart.y_axis.delete = False   # see Gotchas — axes can vanish without this

data = Reference(ws, min_col=2, min_row=1, max_col=3, max_row=13)   # INCLUDES header row
cats = Reference(ws, min_col=1, min_row=2, max_row=13)              # EXCLUDES header row
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)

chart.width, chart.height = 15, 8                  # cm
ws.add_chart(chart, "J2")                          # top-left anchor cell; keep clear of data
```
- Bar variants: `chart = BarChart(); chart.type = "col"` (vertical) or `"bar"` (horizontal); `chart.grouping = "clustered" | "stacked" | "percentStacked"`; stacked also needs `chart.overlap = 100`.
- Pie slice colors: `from openpyxl.chart.series import DataPoint`; `s = chart.series[0]; s.data_points = [DataPoint(idx=i, ...) for ...]`; series fill: `s.graphicalProperties.solidFill = "2563EB"`.
- Scatter: build `Series(Reference(y...), xvalues=Reference(x...), title="...")` and `chart.series.append(series)`.
- Line markers: `chart.series[0].marker.symbol = "circle"`.
- Legend off: `chart.legend = None`; position: `chart.legend.position = "b"`.
- Charts reference ranges — when source rows are added, recreate/extend the `Reference` ranges (they do not auto-grow).
- For month/date x-axes prefer a text label column (`2025-01`, `Jan 2025`); date-axis handling is unreliable across viewers.

## Images
```python
from openpyxl.drawing.image import Image as XLImage   # requires Pillow (in the venv)
img = XLImage("logo.png")
img.width, img.height = 160, 120                      # px
ws.add_image(img, "B2")
```

## Cell comments
```python
from openpyxl.comments import Comment
ws["E2"].comment = Comment("Source: https://example.com/report", "Claude")
```
Classic comments only — threaded comments are not supported by openpyxl.

## Defined names
```python
from openpyxl.workbook.defined_name import DefinedName
wb.defined_names["TaxRate"] = DefinedName("TaxRate", attr_text="'Inputs'!$B$3")
# then usable in formulas: "=B5*(1+TaxRate)" and in validation list sources
```

## Known Gotchas (Do not repeat)
1. **openpyxl never calculates formulas.** A written formula has no cached value; `data_only=True` returns `None` for it until Excel saves the file. Verify numbers by recomputing expected values in Python (see SKILL.md Verification Rules).
2. **Never `wb.save()` a workbook loaded with `data_only=True`** — all formulas are permanently replaced by cached values. Edit/save only the normal-load workbook.
3. `ws.insert_rows()/delete_rows()/insert_cols()/delete_cols()` do NOT update formula references, chart `Reference` ranges, conditional-formatting ranges, table refs, or merged ranges. After structural edits, audit and fix all of them.
4. Styles are per-cell; range objects are tuples. Loop cells to style a range.
5. Writing to a merged range's non-top-left cell raises (`MergedCell` is read-only).
6. `ws.max_row`/`ws.max_column` count formatted-but-empty cells — trust `calculate_dimension()` skeptically on imported files and probe actual values.
7. Chart axes can disappear in Excel unless `chart.x_axis.delete = False` and `chart.y_axis.delete = False` are set when customizing axes.
8. Colors take no `#` prefix; `Font(color="#FF0000")` fails silently or errors.
9. `wb.save()` to a file currently open in Excel fails with PermissionError — save to a new name if the user has the file open.
10. Table `displayName` with spaces or duplicates produces a corrupt file that Excel "repairs" (dropping the table).
11. Avoid full-column formula references (`A:A`) — bound ranges to the table size.
12. `Reference` for `add_data` includes the header row when `titles_from_data=True`; the categories `Reference` excludes it. Off-by-one here silently shifts every series.

## Runnable example (complete build)
```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.chart import LineChart, Reference

wb = Workbook()
ws = wb.active
ws.title = "Summary"

rows = [["Month", "Revenue", "EBITDA", "Margin"],
        ["Jan", 100, 10, "=C2/B2"],
        ["Feb", 120, 18, "=C3/B3"],
        ["Mar", 130, 22, "=C4/B4"]]
for r in rows:
    ws.append(r)

for c in ws["A1:D1"][0]:
    c.font = Font(bold=True, color="FFFFFF")
    c.fill = PatternFill(fill_type="solid", start_color="0F766E")
    c.alignment = Alignment(horizontal="center")
for col, fmt in (("B", '"$"#,##0'), ("C", '"$"#,##0'), ("D", "0.0%")):
    for row in ws[f"{col}2:{col}4"]:
        row[0].number_format = fmt
for col, w in (("A", 10), ("B", 12), ("C", 12), ("D", 10)):
    ws.column_dimensions[col].width = w
ws.freeze_panes = "A2"

chart = LineChart()
chart.title = "Revenue Trend"
chart.y_axis.numFmt = '"$"#,##0'
chart.x_axis.delete = False; chart.y_axis.delete = False
chart.legend = None
data = Reference(ws, min_col=2, min_row=1, max_row=4)
cats = Reference(ws, min_col=1, min_row=2, max_row=4)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.width, chart.height = 12, 7
ws.add_chart(chart, "F2")

wb.save("summary.xlsx")
print("saved")
```
