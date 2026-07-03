export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx,html}"],
  safelist: [
    'pointer-events-none', 'transition-opacity', 'transition-transform', 'duration-300', 'ease-out',
    'text-sm', 'px-2', 'py-1', 'rounded', 'shadow', 'bg-black', 'text-white', 'select-none',
    'z-[9999]'
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
