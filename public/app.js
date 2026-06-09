(() => {
  const apiBase = '';
  const navToggle = document.querySelector('.nav-toggle');
  const siteNav = document.querySelector('.site-nav');
  const toastEl = document.querySelector('[data-toast]');
  let currentUser = null;

  const toast = (message) => {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), 3400);
  };

  const api = async (path, options = {}) => {
    const response = await fetch(`${apiBase}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const isJson = response.headers.get('content-type')?.includes('application/json');
    const payload = isJson ? await response.json() : await response.text();
    if (!response.ok) {
      const error = new Error(payload?.error || payload || 'Request failed');
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  };

  const escapeHtml = (value = '') => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const formatDate = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  };

  const updateAuthButtons = () => {
    document.querySelectorAll('[data-open-auth]').forEach((button) => {
      button.textContent = currentUser ? `Logout @${currentUser.username}` : 'Login';
      button.setAttribute('aria-label', currentUser ? 'Logout' : 'Login or register');
    });
  };

  const refreshMe = async () => {
    try {
      const { user } = await api('/api/auth/me');
      currentUser = user || null;
    } catch (_) {
      currentUser = null;
    }
    updateAuthButtons();
    window.dispatchEvent(new CustomEvent('aion:auth', { detail: currentUser }));
    return currentUser;
  };

  navToggle?.addEventListener('click', () => {
    const expanded = navToggle.getAttribute('aria-expanded') === 'true';
    navToggle.setAttribute('aria-expanded', String(!expanded));
    siteNav?.classList.toggle('open');
  });

  document.querySelectorAll('.site-nav a').forEach((link) => {
    link.addEventListener('click', () => {
      siteNav?.classList.remove('open');
      navToggle?.setAttribute('aria-expanded', 'false');
    });
  });

  const revealItems = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add('visible'));
  }

  const slider = document.querySelector('[data-slider]');
  const prev = document.querySelector('[data-slider-prev]');
  const next = document.querySelector('[data-slider-next]');
  const dots = document.querySelector('[data-slider-dots]');
  if (slider) {
    const cards = [...slider.querySelectorAll('.snap-card')];
    const scrollByCard = (dir) => {
      const amount = cards[0]?.getBoundingClientRect().width || slider.clientWidth * 0.8;
      slider.scrollBy({ left: dir * (amount + 22), behavior: 'smooth' });
    };
    prev?.addEventListener('click', () => scrollByCard(-1));
    next?.addEventListener('click', () => scrollByCard(1));
    cards.forEach((card, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.setAttribute('aria-label', `Go to gallery image ${index + 1}`);
      dot.addEventListener('click', () => card.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }));
      dots?.append(dot);
    });
    const updateDots = () => {
      const center = slider.scrollLeft + slider.clientWidth / 2;
      let active = 0;
      cards.forEach((card, index) => {
        const cardCenter = card.offsetLeft + card.clientWidth / 2;
        if (Math.abs(cardCenter - center) < Math.abs((cards[active].offsetLeft + cards[active].clientWidth / 2) - center)) active = index;
      });
      dots?.querySelectorAll('button').forEach((dot, index) => dot.classList.toggle('active', index === active));
    };
    slider.addEventListener('scroll', () => requestAnimationFrame(updateDots), { passive: true });
    updateDots();
  }

  const lightbox = document.querySelector('[data-lightbox]');
  const lightboxImg = document.querySelector('[data-lightbox-img]');
  const lightboxCaption = document.querySelector('[data-lightbox-caption]');
  document.querySelectorAll('.snap-card').forEach((card) => {
    card.addEventListener('click', () => {
      const img = card.querySelector('img');
      const caption = card.querySelector('figcaption')?.innerText || img?.alt || '';
      if (!lightbox || !img || !lightboxImg) return;
      lightboxImg.src = img.src;
      lightboxImg.alt = img.alt;
      if (lightboxCaption) lightboxCaption.textContent = caption;
      lightbox.showModal();
    });
  });
  document.querySelector('[data-lightbox-close]')?.addEventListener('click', () => lightbox?.close());

  const authModal = document.querySelector('[data-auth-modal]');
  const authNote = document.querySelector('[data-auth-note]');
  document.querySelectorAll('[data-open-auth]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (currentUser) {
        try {
          await api('/api/auth/logout', { method: 'POST', body: '{}' });
          currentUser = null;
          updateAuthButtons();
          toast('Logged out.');
          window.dispatchEvent(new CustomEvent('aion:auth', { detail: null }));
        } catch (error) {
          toast(error.message);
        }
        return;
      }
      authModal?.showModal();
    });
  });
  document.querySelector('[data-close-auth]')?.addEventListener('click', () => authModal?.close());
  document.querySelectorAll('[data-auth-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const selected = tab.dataset.authTab;
      document.querySelectorAll('[data-auth-tab]').forEach((item) => item.classList.toggle('active', item === tab));
      document.querySelectorAll('[data-auth-form]').forEach((form) => form.classList.toggle('is-hidden', form.dataset.authForm !== selected));
    });
  });
  document.querySelectorAll('[data-auth-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const mode = form.dataset.authForm;
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const payload = await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(data) });
        currentUser = payload.user;
        updateAuthButtons();
        authModal?.close();
        toast(mode === 'login' ? 'Logged in.' : 'Account created.');
        window.dispatchEvent(new CustomEvent('aion:auth', { detail: currentUser }));
      } catch (error) {
        if (authNote) authNote.textContent = error.message;
      }
    });
  });

  window.Aion = { api, toast, escapeHtml, formatDate, refreshMe, get currentUser() { return currentUser; } };
  refreshMe();
})();
