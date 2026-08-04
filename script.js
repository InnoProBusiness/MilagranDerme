// ---- Menu toggle ----
const menuToggle = document.getElementById('menuToggle');
const navOverlay = document.getElementById('navOverlay');

function closeMenu(){
  menuToggle.setAttribute('aria-expanded', 'false');
  navOverlay.classList.remove('is-open');
  navOverlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function openMenu(){
  menuToggle.setAttribute('aria-expanded', 'true');
  navOverlay.classList.add('is-open');
  navOverlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

menuToggle.addEventListener('click', () => {
  const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
  isOpen ? closeMenu() : openMenu();
});

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', closeMenu);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

// ---- Scroll reveal ----
const revealEls = document.querySelectorAll('.reveal');
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });

revealEls.forEach((el, i) => {
  el.style.transitionDelay = `${(i % 4) * 0.08}s`;
  revealObserver.observe(el);
});

// ---- Header shrink on scroll ----
const header = document.getElementById('siteHeader');
let lastScroll = 0;
window.addEventListener('scroll', () => {
  const y = window.scrollY;
  header.style.background = y > 40 ? 'rgba(11,10,8,0.75)' : 'transparent';
  header.style.backdropFilter = y > 40 ? 'blur(10px)' : 'none';
  lastScroll = y;
}, { passive: true });

// ---- Countdown to launch ----
const launchDate = new Date('2026-08-25T09:00:00-03:00').getTime();

function updateCountdown() {
  const now = Date.now();
  const diff = launchDate - now;

  const daysEl = document.getElementById('cd-days');
  const hoursEl = document.getElementById('cd-hours');
  const minEl = document.getElementById('cd-min');
  const secEl = document.getElementById('cd-sec');
  if (!daysEl) return;

  if (diff <= 0) {
    daysEl.textContent = '00';
    hoursEl.textContent = '00';
    minEl.textContent = '00';
    secEl.textContent = '00';
    return;
  }

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diff / (1000 * 60)) % 60);
  const seconds = Math.floor((diff / 1000) % 60);

  daysEl.textContent = String(days).padStart(2, '0');
  hoursEl.textContent = String(hours).padStart(2, '0');
  minEl.textContent = String(minutes).padStart(2, '0');
  secEl.textContent = String(seconds).padStart(2, '0');
}

updateCountdown();
setInterval(updateCountdown, 1000);
