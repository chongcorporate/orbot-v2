/* Exact replica of the tailwind.config that used to live inline in index.html
   (Play CDN era, removed v1.20.0), used to compile the static tw-compat.css.
   Content paths are cwd-relative: run the build from the repo root (see README). */
module.exports = {
  darkMode: "class",
  content: [
    "./index.html",
    "./app.js"
  ],
  theme: {
    extend: {
      colors: {
        "surface-container": "#171c25",
        "surface-container-lowest": "#0a0d11",
        "on-primary-fixed": "#04120b",
        "background": "#0c0f14",
        "secondary-fixed": "#ffaa6b",
        "primary": "#3ecf8e",
        "on-secondary": "#2b1400",
        "on-surface-variant": "#b6bec9",
        "outline-variant": "#1f2530",
        "on-tertiary-container": "#2b1400",
        "secondary-container": "#ffaa6b",
        "on-tertiary-fixed-variant": "#2b1400",
        "primary-fixed": "#3ecf8e",
        "surface-container-high": "#1f2530",
        "on-background": "#edf0f4",
        "error-container": "#ff6666",
        "on-surface": "#edf0f4",
        "secondary-fixed-dim": "#ffc898",
        "surface-bright": "#2b3342",
        "on-secondary-fixed-variant": "#2b1400",
        "surface": "#12161d",
        "tertiary-container": "#ff8c00",
        "on-primary-container": "#04120b",
        "tertiary-fixed-dim": "#ffb45c",
        "surface-tint": "#3ecf8e",
        "surface-container-low": "#0f131a",
        "on-secondary-container": "#2b1400",
        "outline": "#7d8794",
        "primary-fixed-dim": "#3ecf8e",
        "tertiary-fixed": "#ffb45c",
        "surface-dim": "#0a0d11",
        "on-secondary-fixed": "#2b1400",
        "secondary": "#ffaa6b",
        "surface-container-highest": "#2b3342",
        "inverse-on-surface": "#0c0f14",
        "on-error": "#3a0000",
        "on-primary": "#04120b",
        "tertiary": "#ff8c00",
        "on-tertiary-fixed": "#2b1400",
        "primary-container": "#3ecf8e",
        "on-primary-fixed-variant": "#04120b",
        "surface-variant": "#1f2530",
        "inverse-surface": "#edf0f4",
        "error": "#ff6666",
        "warning": "#fbbf24",
        "success": "#3ecf8e",
        "on-error-container": "#3a0000",
        "inverse-primary": "#3ecf8e",
        "on-tertiary": "#2b1400"
      },
      borderRadius: {
        "DEFAULT": "0.375rem",
        "sm": "0.25rem",
        "md": "0.5rem",
        "lg": "0.75rem",
        "xl": "1.25rem",
        "2xl": "1.75rem",
        "3xl": "2.25rem",
        "full": "9999px"
      },
      spacing: {
        "margin-desktop": "48px",
        "gutter": "32px",
        "panel-padding": "24px",
        "unit": "4px",
        "margin-mobile": "16px"
      },
      fontFamily: {
        "data-mono": ["IBM Plex Mono"],
        "body-lg": ["Inter"],
        "label-caps": ["Inter"],
        "display-lg": ["Outfit"],
        "body-md": ["Inter"],
        "headline-sm": ["Outfit"],
        "headline-md": ["Outfit"]
      },
      fontSize: {
        "data-mono": ["13px", { "lineHeight": "1.4", "letterSpacing": "0.01em", "fontWeight": "500" }],
        "body-lg": ["16px", { "lineHeight": "1.6", "fontWeight": "400" }],
        "label-caps": ["11px", { "lineHeight": "1.1", "letterSpacing": "0.08em", "fontWeight": "700" }],
        "display-lg": ["52px", { "lineHeight": "1.1", "letterSpacing": "-0.02em", "fontWeight": "800" }],
        "body-md": ["14px", { "lineHeight": "1.5", "fontWeight": "400" }],
        "headline-sm": ["19px", { "lineHeight": "1.35", "fontWeight": "600" }],
        "headline-md": ["26px", { "lineHeight": "1.25", "fontWeight": "700" }]
      }
    }
  },
  plugins: [require("@tailwindcss/forms")]
};
