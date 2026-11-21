/* Load a manifest containing Google Drive links to the required JSON files. */
var YousubManifest = (() => {
  const names = ['yousub-google-drive.json', 'service-account.json'];
  const limit = 256 * 1024;

  function parse(text) {
    let data;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new Error('The configuration manifest is not valid JSON.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The configuration manifest must be a JSON object.');
    return names.map((name) => {
      if (typeof data[name] !== 'string') throw new Error(`${name} must contain a Google Drive file link.`);
      let url;
      try { url = new URL(data[name]); } catch { throw new Error(`${name} must contain a Google Drive file link.`); }
      const match = url.protocol === 'https:' && url.hostname === 'drive.google.com' && !url.username && !url.password &&
        /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/(?:view|preview|edit))?\/?$/.exec(url.pathname);
      if (!match) throw new Error(`${name} must contain an https://drive.google.com/file/d/... link.`);
      return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(match[1])}`;
    });
  }

  async function download(url, fetcher = fetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetcher(url, { credentials: 'omit', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Could not download a linked file (HTTP ${response.status}). Check its sharing settings.`);
      if (Number(response.headers.get('content-length')) > limit) throw new Error('A linked file is too large (maximum 256 KB).');
      const text = (await response.text()).replace(/^\uFEFF/, '');
      if (new TextEncoder().encode(text).length > limit) throw new Error('A linked file is too large (maximum 256 KB).');
      try { JSON.parse(text); } catch { throw new Error('A linked file is not valid JSON. Check that it can be downloaded without signing in.'); }
      return text;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Downloading a linked file timed out.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function load(text, fetcher) {
    const urls = parse(text);
    const [driveText, keyText] = await Promise.all(urls.map((url) => download(url, fetcher)));
    const link = Drive.linkFromConfig(driveText);
    if (!Drive.fileIdOf(link)) throw new Error('The Drive configuration must contain a valid file link.');
    Drive.parseKey(keyText);
    return { link, keyText: keyText.trim() };
  }
  return { parse, load };
})();
