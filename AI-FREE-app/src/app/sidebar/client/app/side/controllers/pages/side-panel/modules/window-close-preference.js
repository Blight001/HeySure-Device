'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const options = Array.from(document.querySelectorAll(
    'input[name="window-close-behavior"]',
  ));
  const status = document.getElementById('window-close-behavior-status');
  if (!options.length) return;
  let persistedBehavior = 'ask';

  const setStatus = (message, state = '') => {
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
  };

  const setSelectedBehavior = (behavior) => {
    options.forEach((option) => {
      option.checked = option.value === behavior;
    });
  };

  const setOptionsDisabled = (disabled) => {
    options.forEach((option) => {
      option.disabled = disabled;
    });
  };

  const loadPreference = async () => {
    try {
      const result = await window.aiFree?.ui?.getWindowCloseBehavior?.();
      if (!result?.ok) throw new Error(result?.error?.message || '读取设置失败');
      persistedBehavior = result.data?.behavior || 'ask';
      setSelectedBehavior(persistedBehavior);
      setStatus('');
    } catch (error) {
      setSelectedBehavior('ask');
      setStatus(error?.message || '读取设置失败', 'error');
    }
  };

  options.forEach((option) => option.addEventListener('change', async () => {
    if (!option.checked) return;
    setOptionsDisabled(true);
    setStatus('保存中…');
    try {
      const result = await window.aiFree?.ui?.setWindowCloseBehavior?.({
        behavior: option.value,
      });
      if (!result?.ok) throw new Error(result?.error?.message || '保存设置失败');
      persistedBehavior = result.data?.behavior || option.value;
      setSelectedBehavior(persistedBehavior);
      setStatus('已保存', 'success');
    } catch (error) {
      setSelectedBehavior(persistedBehavior);
      setStatus(error?.message || '保存设置失败', 'error');
    } finally {
      setOptionsDisabled(false);
    }
  }));

  void loadPreference();
});
