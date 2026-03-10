/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../components/**/*.tsx',
    '../constants.ts',
    '../types.ts',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
