// Opens the side panel when the toolbar icon is pressed.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  /* older builds: the user can still open the panel from the side panel menu */
});
