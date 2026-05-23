// ==================== shared.js - الدوال المشتركة لـ HELAXIA ====================

// ========== السلة ==========
let cart = JSON.parse(localStorage.getItem('helaxia_cart')) || [];

function updateCartCount() { 
    const cartCountEl = document.getElementById('cartCount');
    if (cartCountEl) {
        cartCountEl.innerText = cart.reduce((s, i) => s + (i.quantity || 1), 0); 
    }
}

function addToCart(p) { 
    let existing = cart.find(i => i.id === p.id); 
    existing ? existing.quantity++ : cart.push({...p, quantity: 1}); 
    localStorage.setItem('helaxia_cart', JSON.stringify(cart)); 
    updateCartCount(); 
    showToast(`✅ تم إضافة ${p.name} إلى السلة`);
}

// ========== Toast ==========
function showToast(message) {
    let toast = document.getElementById('customToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'customToast';
        toast.style.cssText = `
            position: fixed; bottom: 30px; left: 50%;
            transform: translateX(-50%) translateY(100px);
            background: rgba(20,35,45,0.95); backdrop-filter: blur(14px);
            border: 1px solid #C0E0FF; border-radius: 50px;
            padding: 10px 25px; color: #C0E0FF; font-size: 0.9rem;
            z-index: 2000; opacity: 0; transition: all 0.3s ease;
            white-space: nowrap; font-weight: bold;
        `;
        document.body.appendChild(toast);
    }
    toast.innerText = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(100px)';
    }, 2000);
}

// ========== نجوم ==========
function createStars() { 
    const starsContainer = document.getElementById('stars');
    if (!starsContainer) return;
    for (let i = 0; i < 80; i++) { 
        let s = document.createElement('div'); 
        s.classList.add('star'); 
        let size = Math.random() * 3 + 1;
        s.style.width = size + 'px'; 
        s.style.height = size + 'px'; 
        s.style.left = Math.random() * 100 + '%'; 
        s.style.top = Math.random() * 100 + '%'; 
        s.style.animationDelay = Math.random() * 5 + 's'; 
        s.style.animationDuration = Math.random() * 3 + 2 + 's'; 
        starsContainer.appendChild(s); 
    } 
}

// ========== تسجيل خروج ==========
function logout() { 
    localStorage.clear(); 
    window.location.href = '/login'; 
}

// ========== تشغيل تلقائي ==========
document.addEventListener('DOMContentLoaded', () => {
    createStars();
    updateCartCount();
});