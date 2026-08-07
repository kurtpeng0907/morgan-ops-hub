/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./frontdesk.html",
    "./client-selection.html",
    "./app.js",
    "./report-accounting-patch.js",
    "./remittance-fields-patch.js"
  ],
  theme: { extend: {} },
  corePlugins: { preflight: true }
};
