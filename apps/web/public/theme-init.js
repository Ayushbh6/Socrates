// The theme before the first paint, so a dark page never flashes light (src/lib/theme.ts keeps it after).
try {
  var choice = localStorage.getItem("socrates.theme");
  var dark = choice === "dark" || (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
} catch (e) {}
