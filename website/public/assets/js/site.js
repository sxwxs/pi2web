(() => {
  'use strict';

  const isZh = document.documentElement.lang.toLowerCase().startsWith('zh');
  const messages = isZh ? { copied: '已复制', copy: '复制' } : { copied: 'Copied', copy: 'Copy' };

  const navToggle = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-nav]');
  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      const open = navToggle.getAttribute('aria-expanded') === 'true';
      navToggle.setAttribute('aria-expanded', String(!open));
      nav.classList.toggle('open', !open);
    });
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) {
        navToggle.setAttribute('aria-expanded', 'false');
        nav.classList.remove('open');
      }
    });
  }

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = button.getAttribute('data-copy');
      let value = target || '';
      if (target && target.startsWith('#')) {
        const node = document.querySelector(target);
        value = node ? node.textContent : '';
      }
      try {
        await navigator.clipboard.writeText(value);
      } catch (_) {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      const label = button.querySelector('.copy-label') || button;
      button.classList.add('copied');
      label.textContent = messages.copied;
      window.setTimeout(() => {
        button.classList.remove('copied');
        label.textContent = messages.copy;
      }, 1600);
    });
  });
})();
