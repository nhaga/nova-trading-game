/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["Outfit", "sans-serif"],
        body: ["Outfit", "sans-serif"],
      },
      colors: {
        surface: "#eeeeee",
        ink: "#2d3134",

        accent: "#3777ff",
        positive: "#0ee072",
        negative: "#fd420e",
        muted: "#5c666c",
      },
      boxShadow: {
        panel: "0 10px 30px 0 rgba(0,0,0,0.15)",
      },
    },
  },
  plugins: [],
};
