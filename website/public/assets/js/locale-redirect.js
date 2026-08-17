(() => {
  const language = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
  window.location.replace(language.toLowerCase().startsWith('zh') ? '/zh/' : '/en/');
})();
