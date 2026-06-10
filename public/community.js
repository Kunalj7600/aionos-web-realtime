(() => {
  const Aion = window.Aion;
  const categoryBox = document.querySelector('[data-categories]');
  const feed = document.querySelector('[data-thread-feed]');
  const searchInput = document.querySelector('[data-search]');
  const sortSelect = document.querySelector('[data-sort]');
  const topicModal = document.querySelector('[data-topic-modal]');
  const topicForm = document.querySelector('[data-topic-form]');
  const topicCategory = document.querySelector('[data-topic-category]');
  const topicNote = document.querySelector('[data-topic-note]');
  const tagCloud = document.querySelector('[data-tag-cloud]');
  const params = new URLSearchParams(location.search);

  let state = {
    category: params.get('category') || 'all',
    filter: '',
    q: '',
    sort: 'latest',
    categories: [],
    threads: [],
    liveConnected: false,
  };

  const socket = window.io ? io({ withCredentials: true }) : null;

  const setLiveStatus = (message) => {
    const dot = document.querySelector('.live-dot');
    if (dot) dot.innerHTML = `<span></span> ${Aion.escapeHtml(message)}`;
  };

  const renderStatsPayload = (stats = {}) => {
    document.querySelector('[data-stat="members"]')?.replaceChildren(document.createTextNode(stats.members ?? '—'));
    document.querySelector('[data-stat="threads"]')?.replaceChildren(document.createTextNode(stats.threads ?? '—'));
    document.querySelector('[data-stat="posts"]')?.replaceChildren(document.createTextNode(stats.posts ?? '—'));
    document.querySelector('[data-stat="online"]')?.replaceChildren(document.createTextNode(stats.online ?? '—'));
  };

  const renderStats = async () => {
    try {
      renderStatsPayload(await Aion.api('/api/stats'));
    } catch (_) {
      renderStatsPayload({ members: '—', threads: '—', posts: '—', online: '—' });
      setLiveStatus('Stats Unavailable');
    }
  };

  const renderCategories = () => {
    const allButton = categoryBox.querySelector('[data-category="all"]');
    allButton?.classList.toggle('active', state.category === 'all' && !state.filter);

    categoryBox.querySelectorAll('.category-row:not([data-category="all"])').forEach((item) => item.remove());

    state.categories.forEach((cat) => {
      const button = document.createElement('button');
      button.className = 'category-row';
      button.dataset.category = cat.slug;
      button.innerHTML = `
        <span class="category-icon">${Aion.escapeHtml(cat.icon || '✦')}</span>
        <span>${Aion.escapeHtml(cat.name)}</span>
        <small>${cat.thread_count || 0}</small>
      `;
      button.classList.toggle('active', state.category === cat.slug);
      button.addEventListener('click', () => selectCategory(cat.slug));
      categoryBox.append(button);
    });

    if (topicCategory) {
      topicCategory.innerHTML = state.categories
        .map((cat) => `<option value="${Aion.escapeHtml(cat.slug)}">${Aion.escapeHtml(cat.name)}</option>`)
        .join('');
    }
  };

  const sortThreads = () => {
    const time = (t) => new Date(t.last_activity_at || t.created_at || 0).getTime() || 0;

    if (state.sort === 'top') {
      state.threads.sort((a, b) =>
        Number(b.is_pinned) - Number(a.is_pinned) ||
        Number(b.votes || 0) - Number(a.votes || 0) ||
        time(b) - time(a)
      );
    } else if (state.sort === 'new') {
      state.threads.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } else if (state.sort === 'views') {
      state.threads.sort((a, b) =>
        Number(b.views || 0) - Number(a.views || 0) ||
        time(b) - time(a)
      );
    } else {
      state.threads.sort((a, b) =>
        Number(b.is_pinned) - Number(a.is_pinned) ||
        time(b) - time(a)
      );
    }
  };

  const matchesSearch = (thread) => {
    const q = state.q.trim().toLowerCase();
    if (!q) return true;

    const tags = Array.isArray(thread.tags)
      ? thread.tags.join(' ')
      : String(thread.tags || '');

    return `${thread.title || ''} ${thread.body || ''} ${tags}`.toLowerCase().includes(q);
  };

  const matchesCategory = (thread) => state.category === 'all' || thread.category_slug === state.category;
  const threadMatchesView = (thread) => matchesCategory(thread) && matchesSearch(thread);

  const threadTemplate = document.querySelector('#thread-template');

  const renderThreads = () => {
    let list = [...state.threads];

    if (state.filter === 'solved') list = list.filter((t) => t.status === 'solved');
    if (state.filter === 'pinned') list = list.filter((t) => Number(t.is_pinned) === 1);
    if (state.filter === 'unanswered') list = list.filter((t) => Number(t.replies || 0) === 0);
    if (state.filter === 'works') list = list.filter((t) => t.type === 'work' || t.category_slug === 'works');

    feed.innerHTML = '';

    if (!list.length) {
      feed.innerHTML = `
        <article class="thread-card glass-card">
          <div>
            <p class="eyebrow">No topics yet</p>
            <h2>Start the first real discussion.</h2>
            <p>Every topic created here is stored in the database and broadcast live to connected visitors.</p>
          </div>
        </article>
      `;
      return;
    }

    list.forEach((thread) => {
      const node = threadTemplate.content.firstElementChild.cloneNode(true);
      const link = node.querySelector('.thread-main');

      link.href = `thread.html?slug=${encodeURIComponent(thread.slug)}`;

      node.querySelector('.category-pill').textContent =
        thread.category_name || thread.category || thread.category_slug || 'General';

      const status = node.querySelector('.thread-status');

      status.className = 'thread-status';

      if (thread.status === 'solved') {
        status.textContent = 'Solved';
        status.classList.add('solved');
      } else if (Number(thread.is_pinned)) {
        status.textContent = 'Pinned';
        status.classList.add('pinned');
      } else {
        status.textContent = thread.type || 'Open';
      }

      node.querySelector('h2').textContent = thread.title || 'Untitled topic';
      node.querySelector('p').textContent = thread.body || '';

      const tags = Array.isArray(thread.tags)
        ? thread.tags
        : String(thread.tags || '').split(',').filter(Boolean);

      node.querySelector('.thread-tags').innerHTML = tags
        .slice(0, 4)
        .map((tag) => `<span>#${Aion.escapeHtml(tag.trim())}</span>`)
        .join('');

      node.querySelector('[data-field="votes"]').textContent = thread.votes || 0;
      node.querySelector('[data-field="replies"]').textContent = thread.replies || 0;
      node.querySelector('[data-field="views"]').textContent = thread.views || 0;

      node.querySelector('.thread-author').textContent =
        `Started by ${thread.display_name || thread.username || 'AION member'} · last active ${Aion.formatDate(thread.last_activity_at || thread.created_at)}`;

      feed.append(node);
    });
  };

  const renderTags = () => {
    if (!tagCloud) return;

    const tags = new Map();

    state.threads.forEach((thread) => {
      const list = Array.isArray(thread.tags)
        ? thread.tags
        : String(thread.tags || '').split(',');

      list.forEach((tag) => {
        const clean = tag.trim();
        if (clean) tags.set(clean, (tags.get(clean) || 0) + 1);
      });
    });

    const html = [...tags.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([tag]) => `<span>#${Aion.escapeHtml(tag)}</span>`)
      .join('');

    tagCloud.innerHTML = html || '<span>Tags will appear when members post topics</span>';
  };

  const loadCategories = async () => {
    try {
      const payload = await Aion.api('/api/categories');
      state.categories = payload.categories || [];
      renderCategories();
    } catch (error) {
      categoryBox.innerHTML = `
        <button class="category-row active" data-category="all">
          <span class="category-icon">!</span>
          <span>Forum offline</span>
          <small>API</small>
        </button>
      `;
    }
  };

  const loadThreads = async ({ quiet = false } = {}) => {
    if (!quiet) {
      feed.innerHTML = `
        <article class="thread-skeleton glass-card"></article>
        <article class="thread-skeleton glass-card"></article>
        <article class="thread-skeleton glass-card"></article>
      `;
    }

    try {
      const query = new URLSearchParams({ sort: state.sort });

      if (state.category !== 'all') query.set('category', state.category);
      if (state.q) query.set('q', state.q);

      const payload = await Aion.api(`/api/threads?${query}`);
      state.threads = payload.threads || [];

      sortThreads();
      renderThreads();
      renderTags();
    } catch (error) {
      console.error('Thread loading failed:', error);

      feed.innerHTML = `
        <article class="thread-card glass-card">
          <div>
            <p class="eyebrow">Forum feed error</p>
            <h2>The forum API responded with an error.</h2>
            <p>${Aion.escapeHtml(error.message || 'Unknown error')}</p>
            <p class="muted">Check Render Logs for the full backend error.</p>
          </div>
        </article>
      `;
    }
  };

  const upsertThread = (thread) => {
    if (!thread || !threadMatchesView(thread)) {
      state.threads = state.threads.filter((item) => item.id !== thread?.id);
      renderThreads();
      renderTags();
      return;
    }

    const index = state.threads.findIndex((item) => item.id === thread.id);

    if (index >= 0) state.threads[index] = thread;
    else state.threads.unshift(thread);

    sortThreads();
    renderThreads();
    renderTags();
  };

  const selectCategory = (category) => {
    state.category = category;
    state.filter = '';

    document.querySelectorAll('.category-row').forEach((button) => {
      button.classList.toggle('active', button.dataset.category === category);
    });

    document.querySelectorAll('.filter-row').forEach((button) => {
      button.classList.remove('active');
    });

    socket?.emit('forum:join', { category });
    loadThreads();
  };

  categoryBox.querySelector('[data-category="all"]')?.addEventListener('click', () => selectCategory('all'));

  document.querySelectorAll('.filter-row').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll('.filter-row').forEach((item) => item.classList.toggle('active', item === button));
      renderThreads();
    });
  });

  let searchTimer;

  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);

    searchTimer = setTimeout(() => {
      state.q = searchInput.value.trim();
      loadThreads({ quiet: true });
    }, 250);
  });

  sortSelect?.addEventListener('change', () => {
    state.sort = sortSelect.value;
    loadThreads();
  });

  document.querySelector('[data-refresh]')?.addEventListener('click', () => {
    loadCategories();
    loadThreads();
    renderStats();
  });

  document.querySelectorAll('[data-open-topic]').forEach((button) => {
    button.addEventListener('click', () => topicModal?.showModal());
  });

  document.querySelector('[data-close-topic]')?.addEventListener('click', () => topicModal?.close());

  topicForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const raw = Object.fromEntries(new FormData(topicForm).entries());

    raw.tags = String(raw.tags || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);

    try {
      const payload = await Aion.api('/api/threads', {
        method: 'POST',
        body: JSON.stringify(raw),
      });

      topicModal.close();
      topicForm.reset();
      Aion.toast('Topic published live.');

      location.href = `thread.html?slug=${encodeURIComponent(payload.thread.slug)}`;
    } catch (error) {
      if (error.status === 401) {
        topicNote.textContent = 'Please login before posting.';
        document.querySelector('[data-auth-modal]')?.showModal();
      } else {
        topicNote.textContent = error.message;
      }
    }
  });

  socket?.on('connect', () => {
    state.liveConnected = true;
    setLiveStatus('Live updates connected');
    socket.emit('forum:join', { category: state.category });
  });

  socket?.on('disconnect', () => {
    state.liveConnected = false;
    setLiveStatus('Realtime reconnecting…');
  });

  socket?.on('presence:updated', ({ online }) => {
    document.querySelector('[data-stat="online"]')?.replaceChildren(document.createTextNode(online ?? '—'));
  });

  socket?.on('stats:updated', renderStatsPayload);

  socket?.on('categories:updated', ({ categories }) => {
    state.categories = categories || [];
    renderCategories();
  });

  socket?.on('thread:created', ({ thread }) => {
    upsertThread(thread);
    Aion.toast('New topic posted live.');
  });

  socket?.on('thread:updated', ({ thread }) => upsertThread(thread));

  window.addEventListener('aion:auth', () => {
    loadThreads({ quiet: true });
    renderStats();
  });

  loadCategories().then(loadThreads);
  renderStats();
})();
