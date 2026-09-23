import { useThemeStore } from "../stores/themeStore";

export function ThemeToggle() {
  const { theme, toggle } = useThemeStore();
  return (
    <button
      onClick={toggle}
      title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
      style={{
        width: 26,
        height: 26,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 4,
        color: "var(--text-secondary)",
        cursor: "pointer",
        fontSize: 14,
        flexShrink: 0,
      }}
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}
