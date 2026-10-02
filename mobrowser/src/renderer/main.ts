import { ipc } from './gen/ipc';

const greetInput = document.querySelector("#greet-input") as HTMLInputElement;
const btn = document.querySelector("#greet-btn") as HTMLInputElement;

export function sayHello() {
    const name = greetInput?.value;
    ipc.greet.SayHello({ name: name }).then((message) =>
        document.querySelector("#greet-msg")!.textContent = message.value
    );
}

greetInput.addEventListener('keypress', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
        btn.click();
    }
});

btn.addEventListener("click", () => sayHello());

if (window.navigator.userAgent.indexOf("Mac") !== -1) {
    const draggableRegion = document.createElement("div");
    draggableRegion.classList.add("draggable");
    document.body.appendChild(draggableRegion);
}

// Theme management
const themeLightBtn = document.getElementById("theme-light");
const themeSystemBtn = document.getElementById("theme-system");
const themeDarkBtn = document.getElementById("theme-dark");
const themeToggleBg = document.getElementById("theme-toggle-bg");

let currentTheme = localStorage.getItem("mobrowser-theme") || "system";

function applyTheme(theme: string) {
    currentTheme = theme;
    localStorage.setItem("mobrowser-theme", theme);
    
    // Update active button
    themeLightBtn?.classList.toggle("active", theme === "light");
    themeSystemBtn?.classList.toggle("active", theme === "system");
    themeDarkBtn?.classList.toggle("active", theme === "dark");

    // Update background slider
    if (themeToggleBg) {
        themeToggleBg.className = `theme-toggle-bg ${theme}`;
    }

    // Determine actual dark mode
    const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    
    // Apply CSS class
    if (isDark) {
        document.documentElement.classList.add("dark");
    } else {
        document.documentElement.classList.remove("dark");
    }
    
    // Notify main process
    if (ipc.app && ipc.app.SetTheme) {
        ipc.app.SetTheme({ theme }).catch(console.error);
    }
}

themeLightBtn?.addEventListener("click", () => applyTheme("light"));
themeSystemBtn?.addEventListener("click", () => applyTheme("system"));
themeDarkBtn?.addEventListener("click", () => applyTheme("dark"));

// Listen for system theme changes
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentTheme === "system") {
        applyTheme("system");
    }
});

// Initial apply
applyTheme(currentTheme);
