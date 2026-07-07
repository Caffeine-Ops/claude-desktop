# Chart Requirements and Guidance

Use charts to help clarify a KPI, comparison, trend, distribution, or relationship. Tables are better for exact lookup or dense row-level review.

## General Chart Guidance
- Use native Excel charts via openpyxl (`openpyxl.chart` — see API_QUICK_START.md Charts section for the API and the supported-type list)
- Avoid redundant charts. Each chart must communicate distinct takeaways.
- Chart source tables should have visible text, wrapping and widening when needed.
- For time-based charts, if raw dates would create crowded labels or unreliable date-axis grouping, add a grouped field such as Year, Quarter, Month, or Week to the chart source.

## Creating Excel Charts

Optimize for one clear takeaway and prioritize the data. Use color only for meaning, and keep labels, units, and comparisons easy to read.

1. Choose the takeaway and most suitable chart type for the data.
Examples below are guidance, not hard rules:
- For category comparison or ranking, consider a sorted bar/column chart.
- For trends over time, consider a line chart; use area charts only when the filled volume adds meaning.
- For part-to-whole, consider a sorted bar chart, compact table, or pie/doughnut when there are only a few slices and the rough share is the point.
- For distributions, bucket the data with formulas (`COUNTIFS`/`FREQUENCY` helper range) and chart the buckets as a column chart — openpyxl has no native histogram/boxWhisker type. When median/spread/outliers are the point, add a compact summary-statistics block instead.
- For exact values across a small number of items, consider a table instead of a chart.
- For a single metric with context, consider a KPI cell plus a small compact line chart (openpyxl does not support sparklines).
Prefer the chart that makes the intended takeaway easiest to see, even if it differs from the examples.

2. Use auditable chart data
- Chart ranges must be formula-backed, dynamic where practical, and traceable to source data.
- Prefer direct series references to source data, so that when source data changes, charts are updated.
- Fallback: Use helper ranges only for reshaping, grouping dates, shortening labels, export/render workarounds, or a useful compact chart-driving table. Helper ranges must reference source cells with formulas, not hardcoded copied values.

3. Place the chart cleanly
- Place near the KPI block or table they explain.
- Leave enough whitespace. Do not overlap source data, controls, notes, or other charts.
- Align related charts and keep comparable charts consistent in scale, units, colors, and date ranges.
- Size charts by rendered density, not available grid space. Keep small charts compact; expand only when labels, legends, or dense data need it. In visual QA, shrink charts with obvious unused plot area or whitespace around a small number of marks. Very wide or tall charts without a clear need look unprofessional.

4. Format titles, axes, and labels
- Use simple and human readable chart titles, e.g. `Revenue rose 18% YoY, led by Enterprise`, `Profit by Category ($bn)`, `User Engagement`. Do not make up words or use obscure phrases.
- Keep chart titles professional and no larger than surrounding section labels, usually 12-14 pt.
- Make units visible in the title, axis, or labels: %, $, hours, count, dates, etc.
- Set axis number formats explicitly, even when source cells are already formatted. Number formatting is required for percent, currency, dates/timestamps.
- Add axis titles only when the axis meaning or unit is not already clear from the title, tick labels, or data labels.
- Shorten long category labels with formula-backed helper labels; keep full labels in the source table.
- Use data labels only when exact values matter or the axis is hard to read.
- Do not label every point in dense line charts.
- Prefer direct series labels for a few series; use legends only when needed and place them where they do not crowd the plot.

5. Use restrained chart design
- Use color for meaning, not decoration. Keep color meanings consistent across related charts.
- Avoid chartjunk unless asked: unnecessary gradients, heavy borders, excessive gridlines, or decorative effects.
- Use meaningful ordering: time order for time series, descending values for rankings, process order for workflows.
- Ensure titles, axes, tick labels, legends, and important values are readable at normal zoom without clipping or overlap.

6. Verify
- Reload the saved file and confirm each chart's `Reference` ranges point at the intended cells (right sheet, header row included for data / excluded for categories, last row correct).
- Check for stale ranges after row additions, formula errors in source ranges, missing axis number formats, and unsupported chart types.
- If LibreOffice is available, convert to PDF for a visual pass (see SKILL.md Verification Rules): look for blank charts, clipped labels, overcrowded ticks, unreadable units.
- If the requested chart type is not supported by openpyxl (treemap, sunburst, histogram, boxWhisker, waterfall, funnel, map), use the closest clear alternative and preserve the intended takeaway; note the substitution in the final response.


## Editing Existing Charts
Prior to editing a chart, inspect the chart's source ranges, related cells, formulas and series (`ws._charts` on load exposes existing chart objects; read their series references). Preserve the existing layout and scope unless redesign is requested. If adding data causes overlap, first resize or shift minimally within the same visual zone. After edits, re-verify that series/category ranges cover the intended data, axes have number formats, and labels stay readable. Inspect the source range for formula errors. Preserve unrelated pre-existing errors, mention them in the final response, and fix them only when they directly break the chart or the user asked for repair/audit. Note: openpyxl's round-trip support for charts on loaded files is limited — charts it didn't create may lose custom styling when the file is re-saved; warn the user when re-saving a workbook that contains pre-existing complex charts.
