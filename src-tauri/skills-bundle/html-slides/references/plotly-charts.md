# Plotly.js Chart Reference

## CDN Import

```html
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js" charset="utf-8"></script>
```

## Blending With Slide Background

Chart backgrounds must be transparent so they can blend with the custom background color of the slide. The `font.color` and `gridcolor` of each presentation should be adjusted according to the color scheme you design. **Do not use the default values below**:

```javascript
// This is a template example; colors should be adjusted according to your theme
const slideLayout = {
  paper_bgcolor: 'rgba(0,0,0,0)',   // Transparent, blends into the slide background
  plot_bgcolor:  'rgba(0,0,0,0)',   // Transparent
  font: { family: 'YOUR_FONT', color: 'YOUR_TEXT_COLOR' },
  xaxis: { gridcolor: 'rgba(255,255,255,0.08)', linecolor: 'rgba(255,255,255,0.1)' },
  yaxis: { gridcolor: 'rgba(255,255,255,0.08)', linecolor: 'rgba(255,255,255,0.1)' },
  margin: { l: 60, r: 30, t: 30, b: 50 },
  hoverlabel: { bgcolor: '#1a1a2e', font: { color: '#ffffff' } }
};
const config = { responsive: true, displayModeBar: false };
```

## Common Charts

**Line Chart / Trend**
```javascript
Plotly.newPlot('chart-id', [{
  x: ['Q1', 'Q2', 'Q3', 'Q4'], y: [2.1, 2.8, 3.2, 4.1],
  type: 'scatter', mode: 'lines+markers',
  line: { color: 'YOUR_ACCENT', width: 3, shape: 'spline' },
  marker: { size: 8 },
  hovertemplate: '%{x}: %{y}<extra></extra>'
}], slideLayout, config);
```

**Bar Chart**
```javascript
Plotly.newPlot('chart-id', [{
  x: ['A', 'B', 'C'], y: [42, 38, 28],
  type: 'bar',
  marker: { color: ['COLOR1', 'COLOR2', 'COLOR3'] },
  hovertemplate: '%{x}: %{y}%<extra></extra>'
}], { ...slideLayout, bargap: 0.3 }, config);
```

**Doughnut Chart**
```javascript
Plotly.newPlot('chart-id', [{
  labels: ['A', 'B', 'C'], values: [45, 30, 25],
  type: 'pie', hole: 0.5,
  marker: { colors: ['COLOR1', 'COLOR2', 'COLOR3'] },
  textinfo: 'label+percent', textfont: { color: '#ffffff' },
  hovertemplate: '%{label}: %{percent}<extra></extra>'
}], slideLayout, config);
```

**Area Chart** (add fill to the line chart trace)
```javascript
{ type: 'scatter', mode: 'lines', fill: 'tozeroy',
  fillcolor: 'rgba(R,G,B,0.1)', line: { color: 'YOUR_ACCENT', width: 2, shape: 'spline' } }
```

**Scatter Plot**
```javascript
{ type: 'scatter', mode: 'markers',
  marker: { size: 12, color: values, colorscale: 'Viridis', showscale: true } }
```

**Heatmap**
```javascript
{ type: 'heatmap', z: [[1,20,30],[20,1,60],[30,60,1]],
  x: ['A','B','C'], y: ['A','B','C'],
  colorscale: [[0, '#000'], [1, 'YOUR_ACCENT']] }
```

**3D Surface Plot**
```javascript
{ type: 'surface', z: zData, colorscale: 'Viridis',
  contours: { z: { show: true, usecolormap: true, project: { z: true } } } }
```


## Subplots

Display multiple charts side by side in one slide, suitable for multidimensional comparative analysis.

```javascript
// 2x2 subplot grid
Plotly.newPlot('chart-id', [
  // Top left: line chart
  {
    x: ['Q1','Q2','Q3','Q4'], y: [120,150,180,210],
    type: 'scatter', mode: 'lines+markers',
    line: { color: '#38bdf8' }, xaxis: 'x', yaxis: 'y',
    name: 'Revenue'
  },
  // Top right: bar chart
  {
    x: ['Q1','Q2','Q3','Q4'], y: [30,25,35,40],
    type: 'bar', marker: { color: '#818cf8' },
    xaxis: 'x2', yaxis: 'y2', name: 'Profit'
  },
  // Bottom left: area chart
  {
    x: ['Q1','Q2','Q3','Q4'], y: [500,620,580,710],
    type: 'scatter', fill: 'tozeroy',
    fillcolor: 'rgba(52,211,153,0.15)', line: { color: '#34d399' },
    xaxis: 'x3', yaxis: 'y3', name: 'Users'
  },
  // Bottom right: scatter plot
  {
    x: [1,2,3,4,5], y: [10,15,13,17,20],
    type: 'scatter', mode: 'markers',
    marker: { size: 12, color: '#fbbf24' },
    xaxis: 'x4', yaxis: 'y4', name: 'Conversion Rate'
  }
], {
  ...darkLayout,
  grid: { rows: 2, columns: 2, pattern: 'independent', xgap: 0.1, ygap: 0.15 },
  showlegend: false,
  // Each subplot axis inherits the dark grid
  xaxis:  { gridcolor: 'rgba(255,255,255,0.06)' },
  xaxis2: { gridcolor: 'rgba(255,255,255,0.06)' },
  xaxis3: { gridcolor: 'rgba(255,255,255,0.06)' },
  xaxis4: { gridcolor: 'rgba(255,255,255,0.06)' },
  yaxis:  { gridcolor: 'rgba(255,255,255,0.06)' },
  yaxis2: { gridcolor: 'rgba(255,255,255,0.06)' },
  yaxis3: { gridcolor: 'rgba(255,255,255,0.06)' },
  yaxis4: { gridcolor: 'rgba(255,255,255,0.06)' },
}, plotlyConfig);
```

**Key**: use `grid: { rows, columns, pattern: 'independent' }` to automatically arrange subplots.

---

## Maps (Choropleth / Geo)

### World Map — Regional Fill

Suitable for displaying market share, revenue distribution, and similar data across countries/regions.

```javascript
Plotly.newPlot('chart-id', [{
  type: 'choropleth',
  locations: ['JPN', 'CHN', 'USA', 'DEU', 'GBR', 'AUS'],
  z: [62.3, 26.9, 3.2, 2.1, 1.8, 1.5],
  text: ['Japan 62.3%', 'China 26.9%', 'United States 3.2%', 'Germany 2.1%', 'United Kingdom 1.8%', 'Australia 1.5%'],
  colorscale: [[0, '#1e293b'], [0.5, '#38bdf8'], [1, '#818cf8']],
  marker: { line: { color: '#0f172a', width: 0.5 } },
  colorbar: { tickfont: { color: '#94a3b8' }, title: { text: 'Revenue Share %', font: { color: '#94a3b8' } } },
  hovertemplate: '%{text}<extra></extra>'
}], {
  ...darkLayout,
  geo: {
    bgcolor: 'rgba(0,0,0,0)',
    showframe: false,
    showcoastlines: true,
    coastlinecolor: 'rgba(255,255,255,0.15)',
    showland: true, landcolor: '#1e293b',
    showocean: true, oceancolor: '#0f172a',
    showcountries: true, countrycolor: 'rgba(255,255,255,0.1)',
    projection: { type: 'natural earth' }
  }
}, plotlyConfig);
```

### Scatter Map — Mark City / Store Locations

```javascript
Plotly.newPlot('chart-id', [{
  type: 'scattergeo',
  lat: [35.6762, 31.2304, 40.7128, 51.5074],
  lon: [139.6503, 121.4737, -74.0060, -0.1278],
  text: ['Tokyo (320 stores)', 'Shanghai (85 stores)', 'New York (12 stores)', 'London (8 stores)'],
  marker: {
    size: [32, 18, 8, 6],           // Bubble size maps to store count
    color: '#38bdf8',
    line: { width: 1, color: '#0f172a' },
    opacity: 0.8
  },
  hovertemplate: '%{text}<extra></extra>'
}], {
  ...darkLayout,
  geo: {
    bgcolor: 'rgba(0,0,0,0)',
    showframe: false, showcoastlines: true,
    coastlinecolor: 'rgba(255,255,255,0.15)',
    showland: true, landcolor: '#1e293b',
    projection: { type: 'natural earth' }
  }
}, plotlyConfig);
```

---

## Sankey Diagram

Show flow relationships such as capital flow, user conversion funnels, and supply chains.

```javascript
Plotly.newPlot('chart-id', [{
  type: 'sankey',
  orientation: 'h',
  node: {
    label: ['Total Visits', 'Signups', 'Activated', 'Paid', 'Renewed', 'Churned'],
    color: ['#38bdf8', '#818cf8', '#34d399', '#fbbf24', '#38bdf8', '#fb7185'],
    pad: 20,
    thickness: 20,
    line: { color: 'rgba(0,0,0,0)', width: 0 }
  },
  link: {
    source: [0, 0, 1, 2, 3, 3],     // Source index
    target: [1, 5, 2, 3, 4, 5],     // Target index
    value:  [1000, 200, 800, 600, 450, 150],
    color: [
      'rgba(56,189,248,0.3)', 'rgba(251,113,133,0.3)',
      'rgba(129,140,248,0.3)', 'rgba(52,211,153,0.3)',
      'rgba(56,189,248,0.3)', 'rgba(251,113,133,0.3)'
    ]
  }
}], {
  ...darkLayout,
  margin: { l: 30, r: 30, t: 20, b: 20 }
}, plotlyConfig);
```

---

## Dashboard Indicator (Indicator / Gauge)

Large-screen KPI display, suitable for opening data overviews or summary pages.

### Large KPI Number

```javascript
Plotly.newPlot('chart-id', [{
  type: 'indicator',
  mode: 'number+delta',
  value: 7846,
  delta: { reference: 6620, valueformat: '.0f', increasing: { color: '#34d399' } },
  number: {
    font: { size: 72, color: '#f1f5f9', family: 'Inter' },
    valueformat: ',',
    suffix: ' hundred million'
  },
  title: { text: 'FY2025 Revenue (JPY)', font: { size: 16, color: '#94a3b8' } },
  domain: { x: [0, 1], y: [0, 1] }
}], {
  ...darkLayout,
  margin: { l: 20, r: 20, t: 60, b: 20 }
}, plotlyConfig);
```

### Gauge

```javascript
Plotly.newPlot('chart-id', [{
  type: 'indicator',
  mode: 'gauge+number',
  value: 85,
  gauge: {
    axis: { range: [0, 100], tickcolor: '#64748b' },
    bar: { color: '#38bdf8' },
    bgcolor: '#1e293b',
    bordercolor: 'rgba(255,255,255,0.1)',
    steps: [
      { range: [0, 50], color: 'rgba(251,113,133,0.15)' },
      { range: [50, 80], color: 'rgba(251,191,36,0.15)' },
      { range: [80, 100], color: 'rgba(52,211,153,0.15)' }
    ],
    threshold: { line: { color: '#34d399', width: 3 }, value: 80 }
  },
  number: { font: { color: '#f1f5f9', size: 48 }, suffix: '%' },
  title: { text: 'Customer Satisfaction', font: { color: '#94a3b8', size: 14 } }
}], {
  ...darkLayout,
  margin: { l: 40, r: 40, t: 60, b: 20 }
}, plotlyConfig);
```

---

## Treemap / Sunburst

Display hierarchical structures: revenue composition, organizational structure, product categories.

### Treemap

```javascript
Plotly.newPlot('chart-id', [{
  type: 'treemap',
  labels:  ['Total Revenue', 'Japan', 'China', 'Overseas', 'Apparel', 'Home', 'Food', 'Apparel CN', 'Home CN'],
  parents: ['',              'Total Revenue','Total Revenue','Total Revenue','Japan','Japan','Japan','China','China'],
  values:  [7846,            4890,           2112,           844,            2200,   1800,   890,    1200,        912],
  textinfo: 'label+value',
  marker: {
    colors: ['#1e293b','#38bdf8','#818cf8','#34d399','#38bdf8','#0ea5e9','#0284c7','#818cf8','#6366f1'],
    line: { width: 2, color: '#0f172a' }
  },
  textfont: { color: '#f1f5f9' },
  hovertemplate: '%{label}<br>¥%{value} hundred million<br>Share: %{percentRoot:.1%}<extra></extra>'
}], {
  ...darkLayout,
  margin: { l: 10, r: 10, t: 10, b: 10 }
}, plotlyConfig);
```

### Sunburst

```javascript
{
  type: 'sunburst',
  labels:  ['Total Revenue', 'Japan', 'China', 'Overseas', 'Apparel', 'Home', 'Food'],
  parents: ['',              'Total Revenue','Total Revenue','Total Revenue','Japan','Japan','Japan'],
  values:  [7846,            4890,           2112,           844,            2200,   1800,   890],
  branchvalues: 'total',
  marker: { line: { width: 2, color: '#0f172a' } },
  textfont: { color: '#f1f5f9' }
}
```

---

## Interactive Controls (Sliders / Buttons / Dropdowns)

Let the audience dynamically switch data dimensions through controls, which is very suitable for presentation scenarios.

### Dropdown Menu — Switch Data Dimension

```javascript
Plotly.newPlot('chart-id', [
  { x: years, y: revenueData, type: 'bar', marker: { color: '#38bdf8' }, visible: true, name: 'Revenue' },
  { x: years, y: profitData,  type: 'bar', marker: { color: '#34d399' }, visible: false, name: 'Profit' },
  { x: years, y: growthData,  type: 'scatter', mode: 'lines+markers', line: { color: '#fbbf24' }, visible: false, name: 'Growth Rate' }
], {
  ...darkLayout,
  updatemenus: [{
    type: 'dropdown',
    x: 0.05, y: 1.15,
    bgcolor: '#1e293b',
    bordercolor: 'rgba(255,255,255,0.1)',
    font: { color: '#f1f5f9' },
    buttons: [
      { label: 'Revenue', method: 'update', args: [{ visible: [true, false, false] }, { title: 'Annual Revenue' }] },
      { label: 'Profit', method: 'update', args: [{ visible: [false, true, false] }, { title: 'Annual Profit' }] },
      { label: 'Growth Rate', method: 'update', args: [{ visible: [false, false, true] }, { title: 'Annual Growth Rate' }] }
    ]
  }]
}, plotlyConfig);
```

### Slider — Dynamic Time-Series Display

```javascript
// Prepare frame data
const frames = years.map(year => ({
  name: year,
  data: [{ x: categories, y: dataByYear[year], type: 'bar' }]
}));

Plotly.newPlot('chart-id',
  [{ x: categories, y: dataByYear[years[0]], type: 'bar', marker: { color: '#38bdf8' } }],
  {
    ...darkLayout,
    sliders: [{
      active: 0,
      pad: { t: 40 },
      steps: years.map((year, i) => ({
        label: year,
        method: 'animate',
        args: [[year], { mode: 'immediate', transition: { duration: 300 }, frame: { duration: 300 } }]
      })),
      bgcolor: '#1e293b',
      bordercolor: 'rgba(255,255,255,0.1)',
      font: { color: '#94a3b8' },
      activebgcolor: '#38bdf8'
    }]
  },
  plotlyConfig
);
Plotly.addFrames('chart-id', frames);
```

### Play Button — Automatic Animation

```javascript
// Add play/pause buttons in layout.updatemenus
updatemenus: [{
  type: 'buttons',
  showactive: false,
  x: 0.05, y: 1.12,
  buttons: [
    {
      label: '▶ Play',
      method: 'animate',
      args: [null, { fromcurrent: true, frame: { duration: 800 }, transition: { duration: 400 } }]
    },
    {
      label: '⏸ Pause',
      method: 'animate',
      args: [[null], { mode: 'immediate', frame: { duration: 0 } }]
    }
  ]
}]
```

---

## Range Slider — Data Range Selection

Let the audience independently choose a time window to explore data.

```javascript
Plotly.newPlot('chart-id', [{
  x: dates,     // Date array
  y: values,    // Corresponding values
  type: 'scatter', mode: 'lines',
  line: { color: '#38bdf8', width: 2 }
}], {
  ...darkLayout,
  xaxis: {
    ...darkLayout.xaxis,
    rangeslider: {
      bgcolor: '#1e293b',
      bordercolor: 'rgba(255,255,255,0.1)',
      thickness: 0.08
    },
    rangeselector: {
      bgcolor: '#1e293b',
      activecolor: '#38bdf8',
      font: { color: '#94a3b8' },
      buttons: [
        { count: 3, label: '3M', step: 'month' },
        { count: 6, label: '6M', step: 'month' },
        { count: 1, label: '1Y', step: 'year' },
        { step: 'all', label: 'All' }
      ]
    }
  }
}, plotlyConfig);
```

---

## Waterfall Chart

Show profit breakdown and changes in cost composition.

```javascript
Plotly.newPlot('chart-id', [{
  type: 'waterfall',
  x: ['Total Revenue', 'Cost', 'Gross Profit', 'R&D', 'Marketing', 'Management', 'Net Profit'],
  y: [7846, -3810, null, -520, -380, -290, null],
  measure: ['absolute', 'relative', 'total', 'relative', 'relative', 'relative', 'total'],
  connector: { line: { color: 'rgba(255,255,255,0.1)' } },
  increasing: { marker: { color: '#34d399' } },
  decreasing: { marker: { color: '#fb7185' } },
  totals: { marker: { color: '#38bdf8' } },
  textposition: 'outside',
  textfont: { color: '#94a3b8' },
  hovertemplate: '%{x}: ¥%{y} hundred million<extra></extra>'
}], {
  ...darkLayout,
  showlegend: false
}, plotlyConfig);
```

---

## Radar Chart (Radar / Scatterpolar)

Suitable for multidimensional score comparison: competitor analysis, capability matrix.

```javascript
Plotly.newPlot('chart-id', [
  {
    type: 'scatterpolar', mode: 'lines',
    r: [90, 75, 85, 60, 95, 90],
    theta: ['Brand Strength', 'Price Strength', 'Product Strength', 'Channel Strength', 'Innovation Strength', 'Brand Strength'],
    fill: 'toself',
    fillcolor: 'rgba(56,189,248,0.15)',
    line: { color: '#38bdf8', width: 2 },
    name: 'Us'
  },
  {
    type: 'scatterpolar', mode: 'lines',
    r: [70, 85, 70, 80, 65, 70],
    theta: ['Brand Strength', 'Price Strength', 'Product Strength', 'Channel Strength', 'Innovation Strength', 'Brand Strength'],
    fill: 'toself',
    fillcolor: 'rgba(129,140,248,0.15)',
    line: { color: '#818cf8', width: 2 },
    name: 'Competitor'
  }
], {
  ...darkLayout,
  polar: {
    bgcolor: 'rgba(0,0,0,0)',
    radialaxis: { gridcolor: 'rgba(255,255,255,0.08)', linecolor: 'rgba(255,255,255,0.1)', range: [0, 100] },
    angularaxis: { gridcolor: 'rgba(255,255,255,0.08)', linecolor: 'rgba(255,255,255,0.1)' }
  },
  legend: { font: { color: '#94a3b8' } }
}, plotlyConfig);
```
