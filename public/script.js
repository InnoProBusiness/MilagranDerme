// ============================================================
// CONFIG — ajuste aqui
// ============================================================
const MARGEM_REPRESENTANTE = 20; // percentual de margem por kit vendido — ajuste aqui

// ============================================================
// Tracking helper — no-op até Meta Pixel / GA4 serem instalados
// ============================================================
function trackEvent(name, params = {}) {
  if (typeof window.fbq === 'function') window.fbq('trackCustom', name, params);
  if (typeof window.gtag === 'function') window.gtag('event', name, params);
}

// ---- Margem ----
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('margemValor');
  if (el) {
    el.textContent = MARGEM_REPRESENTANTE !== null ? `Até ${MARGEM_REPRESENTANTE}%` : 'A definir';
  }
});

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

// ---- Header background on scroll ----
const header = document.getElementById('siteHeader');
window.addEventListener('scroll', () => {
  const y = window.scrollY;
  header.style.background = y > 40 ? 'rgba(11,10,8,0.75)' : 'transparent';
  header.style.backdropFilter = y > 40 ? 'blur(10px)' : 'none';
}, { passive: true });

// ---- Nível pré-seleção (cards "Consultar condições") ----
document.querySelectorAll('.nivel-card__cta').forEach(cta => {
  cta.addEventListener('click', () => {
    const nivel = cta.dataset.nivel;
    const select = document.getElementById('nivel');
    if (select && nivel) {
      select.value = nivel;
    }
    trackEvent('consultar_condicoes_click', { nivel });
  });
});

// ============================================================
// Formulário de candidatura
// ============================================================
const form = document.getElementById('candidaturaForm');
const submitBtn = document.getElementById('formSubmit');
const statusEl = document.getElementById('formStatus');

const validators = {
  nome: (v) => v.trim().length >= 3 || 'Informe seu nome completo.',
  whatsapp: (v) => /^[\d\s()+-]{10,20}$/.test(v.trim()) || 'Informe um WhatsApp válido.',
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) || 'Informe um e-mail válido.',
  cidade: (v) => v.trim().length >= 2 || 'Informe sua cidade.',
  estado: (v) => v !== '' || 'Selecione seu estado.',
  area: (v) => v !== '' || 'Selecione sua área de atuação.',
  atuaEstetica: (v) => v !== '' || 'Selecione uma opção.',
  nivel: (v) => v !== '' || 'Selecione o nível de interesse.',
  origem: (v) => v !== '' || 'Selecione uma opção.',
};

function clearErrors() {
  form.querySelectorAll('.form__error').forEach(el => { el.textContent = ''; });
  form.querySelectorAll('.form__field').forEach(el => el.classList.remove('form__field--invalid'));
}

function setError(fieldName, message) {
  const errEl = form.querySelector(`[data-error-for="${fieldName}"]`);
  if (errEl) errEl.textContent = message;
  const fieldEl = document.getElementById(fieldName);
  if (fieldEl) {
    const wrapper = fieldEl.closest('.form__field') || fieldEl.closest('.form__consent');
    if (wrapper) wrapper.classList.add('form__field--invalid');
  }
}

function validateForm(data) {
  let isValid = true;
  for (const [field, validate] of Object.entries(validators)) {
    const result = validate(data[field] || '');
    if (result !== true) {
      setError(field, result);
      isValid = false;
    }
  }
  if (!data.lgpd) {
    setError('lgpd', 'É necessário aceitar o uso dos dados para continuar.');
    isValid = false;
  }
  return isValid;
}

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    statusEl.textContent = '';
    statusEl.className = 'form__status';

    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    data.lgpd = form.querySelector('#lgpd').checked;

    if (!validateForm(data)) {
      statusEl.textContent = 'Verifique os campos destacados.';
      statusEl.classList.add('form__status--error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.classList.add('is-loading');

    try {
      const res = await fetch('/api/candidatura', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) throw new Error('request_failed');

      form.reset();
      statusEl.textContent = 'Candidatura enviada! Nossa equipe entrará em contato em breve.';
      statusEl.classList.add('form__status--success');
      trackEvent('candidatura_enviada', { nivel: data.nivel, estado: data.estado });
    } catch (err) {
      statusEl.textContent = 'Não foi possível enviar agora. Tente novamente ou fale com a gente pelo WhatsApp.';
      statusEl.classList.add('form__status--error');
      trackEvent('candidatura_erro');
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove('is-loading');
    }
  });
}
