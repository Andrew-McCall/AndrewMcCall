const OFFSET_X = 12;
const OFFSET_Y = 12;
const ALERT_DURATION = 500; 
const FADE_DURATION = 300; 

export function float_alert(x: number, y: number, text: string): void {
    const prev = document.getElementById("float_alert");
    if (prev) prev.remove();

    const box = document.createElement('div');
    box.id = "float_alert";

    box.classList.add(
        'pointer-events-none',
        'fixed',
        'z-[9999]',
        'text-sm',
        'px-2', 'py-1',
        'rounded',
        'shadow',
        'bg-black',
        'text-white',
        'select-none',
        'transition-opacity',
        'transition-transform',
        'duration-300',
        'ease-out'
    );

    box.style.left = `${x + OFFSET_X}px`;
    box.style.top = `${y}px`;
    box.style.opacity = '1';
    box.style.transform = `translateY(-${OFFSET_Y}px)`; // starting position
    box.textContent = text;
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');

    document.body.appendChild(box);

    // ensure the browser registers the initial styles, then schedule fade+rise
    requestAnimationFrame(() => {
        setTimeout(() => {
            box.style.opacity = '0';
            box.style.transform = `translateY(-${OFFSET_Y + 12}px)`; // rise up further
            // remove after transition finishes
            setTimeout(() => {
                box.remove();
            }, FADE_DURATION);
        }, ALERT_DURATION);
    });
}
