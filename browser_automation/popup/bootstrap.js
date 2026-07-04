try {
    const layout = new URL(window.location.href).searchParams.get('layout') === 'sidebar' ? 'sidebar' : 'popup';
    document.documentElement.dataset.layout = layout;
} catch (_error) {
    document.documentElement.dataset.layout = 'popup';
}

await import('./shared.js');
await import('./cookie-credentials.js');
await import('./register-workbench.js');
await import('./registration-flow.js');
await import('./bindings.js');
await import('./agent-account.js');
