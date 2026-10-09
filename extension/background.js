// The demo's background script (an event page in Firefox MV3). The toolbar
// button opens the Space page in a new tab.
browser.action.onClicked.addListener(() => {
  browser.tabs.create({ url: "space.html" });
});
