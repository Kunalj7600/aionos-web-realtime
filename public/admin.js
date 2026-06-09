(() => {
  const Aion = window.Aion;
  const reportsBox = document.querySelector('[data-reports]');

  const loadReports = async () => {
    if (!reportsBox) return;
    try {
      const { reports } = await Aion.api('/api/admin/reports');
      if (!reports.length) {
        reportsBox.innerHTML = '<p class="form-note">No open reports.</p>';
        return;
      }
      reportsBox.innerHTML = reports.map((report) => `
        <article class="report-card">
          <strong>${Aion.escapeHtml(report.reason)}</strong>
          <p>${Aion.escapeHtml(report.thread_title || report.post_excerpt || 'Reported item')}</p>
          <p class="form-note">By ${Aion.escapeHtml(report.reporter_name || report.reporter_username)} · ${Aion.formatDate(report.created_at)}</p>
        </article>
      `).join('');
    } catch (error) {
      reportsBox.innerHTML = `<p class="form-note">${Aion.escapeHtml(error.status === 403 ? 'Login as an admin or moderator to view reports.' : error.message)}</p>`;
    }
  };

  window.addEventListener('aion:auth', loadReports);
  loadReports();
})();
