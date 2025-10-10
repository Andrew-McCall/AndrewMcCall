const OFFSET_X = 12;
const OFFSET_Y = 24;
const ALERT_DURATION = 1000; 
const FADE_IN_DURATION = 200;
const FADE_OUT_DURATION = 300;

export function float_alert(x: number, y: number, text: string): void {
    const prev = document.getElementById("float_alert");
    if (prev) prev.remove();

    const box = document.createElement('div');
    box.id = "float_alert";

    box.classList.add(
        'fixed',
        'z-[9999]',
        'text-sm',
        'px-2', 'py-1',
        'rounded',
        'shadow',
        'text-white',
        'select-none'
    );

    box.style.left = `${x + OFFSET_X}px`;
    box.style.top = `${y}px`;
    box.style.opacity = '0';
    box.style.transform = `translateY(-${OFFSET_Y}px)`;
    box.style.backgroundColor = 'rgba(0,0,0,0.6)';
    box.textContent = text;
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');

    document.body.appendChild(box);

    const rect = box.getBoundingClientRect();
    const margin = 8;
    const clampedLeft = Math.min(Math.max(x + OFFSET_X, margin), window.innerWidth - rect.width - margin);
    const clampedTop = Math.min(Math.max(y, margin), window.innerHeight - rect.height - margin);
    box.style.left = `${Math.round(clampedLeft)}px`;
    box.style.top = `${Math.round(clampedTop)}px`;

    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setTimeout(() => box.remove(), ALERT_DURATION);
        return;
    }

    const totalDuration = FADE_IN_DURATION + ALERT_DURATION + FADE_OUT_DURATION;

    if (typeof box.animate === 'function') {
        const anim = box.animate(
            [
                { opacity: 0, transform: `translateY(-${OFFSET_Y}px)`, offset: 0 },  
                { opacity: 1, transform: `translateY(-${OFFSET_Y}px)`, offset: FADE_IN_DURATION / totalDuration },  
                { opacity: 1, transform: `translateY(-${OFFSET_Y}px)`, offset: (FADE_IN_DURATION + ALERT_DURATION) / totalDuration }, 
                { opacity: 0, transform: `translateY(-${OFFSET_Y + 12}px)`, offset: 1 } 
            ],
            {
                duration: totalDuration,
                easing: 'cubic-bezier(.2,.8,.2,1)',
                fill: 'forwards'
            }
        );
        anim.addEventListener('finish', () => box.remove(), { once: true });
        anim.addEventListener('cancel', () => box.remove(), { once: true });
    } else {
        // fallback
        requestAnimationFrame(() => {
            box.style.transition = `opacity ${FADE_IN_DURATION}ms ease-out`;
            box.style.opacity = '1';
            setTimeout(() => {
                box.style.transition = `opacity ${FADE_OUT_DURATION}ms ease-out, transform ${FADE_OUT_DURATION}ms ease-out`;
                box.style.opacity = '0';
                box.style.transform = `translateY(-${OFFSET_Y + 12}px)`;
                setTimeout(() => box.remove(), FADE_OUT_DURATION);
            }, ALERT_DURATION);
        });
    }
}
