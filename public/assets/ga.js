// Google Analytics 4 for the public site. Loaded only when public/site.config.json has a gaMeasurementId (the
// server then also adds gtag.js and opens the CSP for Google's endpoints). External file, not inline: the site's
// CSP allows no inline script. Page views for in-site navigation are sent by site.js (single-page sections).
(function () {
    var cfg = {};
    try { cfg = JSON.parse(document.getElementById('site-config').textContent) || {}; } catch (e) { /* none */ }
    if (!cfg.ga) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', cfg.ga, { anonymize_ip: true });
})();
