(() => {
  const Aion = window.Aion;
  const detail = document.querySelector('[data-thread-detail]');
  const replies = document.querySelector('[data-reply-list]');
  const replyForm = document.querySelector('[data-reply-form]');
  const replyNote = document.querySelector('[data-reply-note]');
  const slug = new URLSearchParams(location.search).get('slug');
  const socket = window.io ? io({ withCredentials: true }) : null;
  let currentThread = null;
  let currentPosts = [];

  const renderThread = () => {
    if (!currentThread) return;
    document.title = `${currentThread.title} — Aion Forums`;
    const tags = Array.isArray(currentThread.tags) ? currentThread.tags : String(currentThread.tags || '').split(',').filter(Boolean);
    detail.innerHTML = `
      <div class="thread-row-top">
        <span class="category-pill">${Aion.escapeHtml(currentThread.category_name || currentThread.category_slug || 'General')}</span>
        <span class="thread-status ${currentThread.status === 'solved' ? 'solved' : Number(currentThread.is_pinned) ? 'pinned' : ''}">${currentThread.status === 'solved' ? 'Solved' : Number(currentThread.is_pinned) ? 'Pinned' : Aion.escapeHtml(currentThread.type || 'Open')}</span>
      </div>
      <h1>${Aion.escapeHtml(currentThread.title)}</h1>
      <p>${Aion.escapeHtml(currentThread.body)}</p>
      <div class="thread-tags">${tags.map((tag) => `<span>#${Aion.escapeHtml(tag.trim())}</span>`).join('')}</div>
      <div class="thread-actions">
        <button class="button button-glass" type="button" data-vote="1">▲ Upvote · ${currentThread.votes || 0}</button>
        <button class="button button-glass" type="button" data-bookmark>Bookmark</button>
        <button class="button button-glass" type="button" data-report>Report</button>
      </div>
      <p class="form-note">Started by ${Aion.escapeHtml(currentThread.display_name || currentThread.username || 'AION member')} · ${Aion.formatDate(currentThread.created_at)} · ${currentThread.views || 0} views · live updates enabled</p>
    `;
    detail.querySelector('[data-vote]')?.addEventListener('click', () => vote(1));
    detail.querySelector('[data-bookmark]')?.addEventListener('click', bookmark);
    detail.querySelector('[data-report]')?.addEventListener('click', report);
  };

  const renderReplies = () => {
    replies.innerHTML = currentPosts.map((post) => `
      <article class="reply-card glass-card" data-post-id="${post.id}">
        <div class="reply-meta"><strong>${Aion.escapeHtml(post.display_name || post.username || 'AION member')}</strong><span>${Aion.formatDate(post.created_at)}</span></div>
        <p>${Aion.escapeHtml(post.body)}</p>
        ${post.is_solution ? '<span class="thread-status solved">Solution</span>' : ''}
      </article>
    `).join('') || '<article class="reply-card glass-card"><p>No replies yet. Be the first to help.</p></article>';
  };

  const render = ({ thread, posts }) => {
    currentThread = thread;
    currentPosts = posts || currentPosts;
    renderThread();
    renderReplies();
    socket?.emit('forum:join', { slug: currentThread.slug, category: currentThread.category_slug });
  };

  const renderError = (title, message) => {
    detail.innerHTML = `<p class="eyebrow">Forum unavailable</p><h1>${Aion.escapeHtml(title)}</h1><p>${Aion.escapeHtml(message)}</p>`;
    replies.innerHTML = '';
  };

  const load = async () => {
    if (!slug) {
      renderError('No thread selected', 'Open a real topic from Aion Forums.');
      return;
    }
    try {
      const payload = await Aion.api(`/api/threads/${encodeURIComponent(slug)}`);
      render(payload);
    } catch (error) {
      renderError('The real thread could not be loaded', error.status === 404 ? 'This topic was not found in the database.' : 'Run npm start inside the project folder and refresh. No fake thread is shown here.');
    }
  };

  const vote = async (value) => {
    if (!currentThread) return;
    try {
      const payload = await Aion.api(`/api/threads/${currentThread.id}/vote`, { method: 'POST', body: JSON.stringify({ value }) });
      if (payload.thread) {
        currentThread = payload.thread;
        renderThread();
      }
      Aion.toast('Vote saved live.');
    } catch (error) {
      if (error.status === 401) document.querySelector('[data-auth-modal]')?.showModal();
      Aion.toast(error.status === 401 ? 'Please login to vote.' : error.message);
    }
  };

  const bookmark = async () => {
    if (!currentThread) return;
    try {
      await Aion.api(`/api/threads/${currentThread.id}/bookmark`, { method: 'POST', body: '{}' });
      Aion.toast('Bookmark updated.');
    } catch (error) {
      if (error.status === 401) document.querySelector('[data-auth-modal]')?.showModal();
      Aion.toast(error.status === 401 ? 'Please login to bookmark.' : error.message);
    }
  };

  const report = async () => {
    if (!currentThread) return;
    const reason = prompt('Why are you reporting this thread?');
    if (!reason) return;
    try {
      await Aion.api('/api/reports', { method: 'POST', body: JSON.stringify({ thread_id: currentThread.id, reason }) });
      Aion.toast('Report sent to moderators.');
    } catch (error) {
      if (error.status === 401) document.querySelector('[data-auth-modal]')?.showModal();
      Aion.toast(error.status === 401 ? 'Please login to report.' : error.message);
    }
  };

  replyForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentThread) return;
    const body = new FormData(replyForm).get('body');
    try {
      const payload = await Aion.api(`/api/threads/${encodeURIComponent(currentThread.slug)}/posts`, { method: 'POST', body: JSON.stringify({ body }) });
      if (payload.post && !currentPosts.some((post) => post.id === payload.post.id)) currentPosts.push(payload.post);
      if (payload.thread) currentThread = payload.thread;
      replyForm.reset();
      replyNote.textContent = '';
      renderThread();
      renderReplies();
      Aion.toast('Reply posted live.');
    } catch (error) {
      if (error.status === 401) document.querySelector('[data-auth-modal]')?.showModal();
      replyNote.textContent = error.status === 401 ? 'Please login before replying.' : error.message;
    }
  });

  socket?.on('connect', () => {
    if (currentThread) socket.emit('forum:join', { slug: currentThread.slug, category: currentThread.category_slug });
  });
  socket?.on('thread:updated', ({ thread }) => {
    if (!currentThread || !thread || thread.id !== currentThread.id) return;
    currentThread = thread;
    renderThread();
  });
  socket?.on('post:created', ({ post, thread }) => {
    if (!currentThread || !thread || thread.id !== currentThread.id) return;
    currentThread = thread;
    if (post && !currentPosts.some((item) => item.id === post.id)) {
      currentPosts.push(post);
      renderReplies();
      Aion.toast('New reply arrived live.');
    }
    renderThread();
  });

  window.addEventListener('aion:auth', load);
  load();
})();
