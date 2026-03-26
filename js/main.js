const AppState = {
    weaveLoomData: null,
    weaveFragments: new Map(),
    weaveCorrupts: new Set(),
    weaveFileCountRead: 0
};

document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initScatter();
    initWeave();
});

function initTabs() {
    const btns = document.querySelectorAll('.nav-btn');
    const tabs = document.querySelectorAll('.tab-content');

    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            btns.forEach(b => b.classList.remove('active'));
            tabs.forEach(t => t.classList.remove('active'));

            btn.classList.add('active');
            const targetId = btn.getAttribute('data-target');
            document.getElementById(targetId).classList.add('active');
        });
    });
}
