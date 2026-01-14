/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'dell-blue': '#007DB8',
        'dell-dark': '#1A1A1A',
      }
    },
  },
  plugins: [],
}
