/** Auxilio brand mark. Uses chrome.runtime.getURL so the path resolves to the
 *  absolute chrome-extension:// URL regardless of which page renders it. */
export function Logo({ size = 26 }: { size?: number }) {
  const src = chrome.runtime.getURL('icon/Auxilio-vector-logo.svg');
  return <img src={src} alt="" width={size} height={size} style={{ display: 'block' }} />;
}
