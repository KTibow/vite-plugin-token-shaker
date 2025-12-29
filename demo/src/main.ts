import "./theme.css";

// Test: This variable should be deoptimized since it's referenced in JS
const primaryColor = getComputedStyle(document.documentElement).getPropertyValue("--primary-color");
console.log("Primary color:", primaryColor);
