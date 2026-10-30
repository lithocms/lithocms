// Escape closes the full-screen menu and returns focus to its toggle.
document.addEventListener('keydown', (e) => {
  const menu = document.querySelector('details.menu[open]');
  if (e.key !== 'Escape' || !menu) return;
  menu.open = false;
  menu.querySelector('summary').focus();
});

// Section entrances: each `.rise` fades up once as it enters, its siblings staggered.
// Without this script (or with reduced motion) everything is visible from the start.
(() => {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches)
    return;
  document.documentElement.classList.add('js');
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
  );
  for (const el of document.querySelectorAll('.rise')) {
    const siblings = [...el.parentElement.children].filter((c) => c.classList.contains('rise'));
    el.style.setProperty('--i', String(Math.min(siblings.indexOf(el), 6)));
    io.observe(el);
  }
})();
