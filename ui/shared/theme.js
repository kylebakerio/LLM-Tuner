// Chart.js defaults that match the app's design tokens (tailwind.src.css :root). Loaded right
// after vendor/chart.js, before any chart is built, so every chart inherits the font, ink,
// gridlines and tooltip skin unless it sets its own. Charts that pass explicit colors keep them.
(function chartTheme() {
    if (typeof Chart === 'undefined') return;
    const css = getComputedStyle(document.documentElement);
    const tok = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    const d = Chart.defaults;

    d.font.family = tok('--font-sans', 'Inter, ui-sans-serif, system-ui, sans-serif');
    d.font.size = 11;
    d.color = tok('--text-3', '#959cab');
    d.borderColor = 'rgba(255,255,255,0.06)';

    // Lines: 2px with round joins; hovered points grow a little.
    d.elements.line.borderWidth = 2;
    d.elements.line.borderCapStyle = 'round';
    d.elements.line.borderJoinStyle = 'round';
    d.elements.point.hoverRadius = 4;
    d.elements.point.hoverBorderWidth = 2;

    // Legends: small round swatches instead of 40px boxes.
    const legend = d.plugins.legend.labels;
    legend.usePointStyle = true;
    legend.pointStyle = 'circle';
    legend.boxWidth = 7;
    legend.boxHeight = 7;
    legend.padding = 12;

    const tt = d.plugins.tooltip;
    tt.backgroundColor = 'rgba(20,22,28,0.96)';
    tt.borderColor = tok('--border-strong', '#363a47');
    tt.borderWidth = 1;
    tt.titleColor = tok('--text-1', '#eceef3');
    tt.bodyColor = tok('--text-2', '#b9bec9');
    tt.footerColor = tok('--text-muted', '#747b8c');
    tt.padding = 10;
    tt.cornerRadius = 8;
    tt.caretSize = 5;
    tt.boxPadding = 4;
    tt.usePointStyle = true;
    tt.titleFont = { weight: '600', size: 11.5 };
    tt.bodyFont = { size: 11 };
    tt.bodySpacing = 4;
})();
