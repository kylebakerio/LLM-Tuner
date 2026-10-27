/** @type {import('tailwindcss').Config} */
// vendor/tailwind.css is a STATIC build of this config: run `npm run build:css` after adding a
// class that has never been used before, or it silently does nothing. ui/ is scanned too -- it
// used to be left out, which is why index.html once carried a hand-written block of missing rules.
//
// `gray` and `indigo` are remapped rather than renamed: ~2,000 class uses across index.html,
// script.js and ui/ already speak gray-500 (muted) / gray-800 (borders) / gray-900 (cards) /
// indigo-400 (accent), so restyling the palette restyles the whole app with no markup churn.
// Keep the step roles intact: 950 page, 900 card, 850 raised, 800 border/input, 700 strong
// border, 600 disabled, 500 muted text, 400 secondary, 300-100 primary.
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './script.js', './ui/**/*.{js,html}', './public/**/*.{js,html}'],
  theme: {
    extend: {
      colors: {
        gray: {
          50: '#f6f7f9',
          100: '#eceef3',
          200: '#d9dce4',
          300: '#b9bec9',
          400: '#959cab',
          500: '#747b8c',
          600: '#525867',
          700: '#363a47',
          800: '#252832',
          850: '#1b1e26',
          900: '#14161c',
          950: '#0c0d11',
        },
        indigo: {
          50: '#eef0ff',
          100: '#e0e3ff',
          200: '#c7cbff',
          300: '#a6acff',
          400: '#8c91fd',
          500: '#7275f4',
          600: '#5f5de6',
          700: '#4e4ac9',
          800: '#3e3ba1',
          900: '#33327f',
          950: '#1d1c48',
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
