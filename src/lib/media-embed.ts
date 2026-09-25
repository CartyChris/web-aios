/* Sound for video pages.

   A cloud browser's live view is a screen stream: Steel documents no audio
   track and no session option for one, so a video playing there is silent
   however the page is set up. Sound works when the media plays HERE, in this
   browser. The providers' own embeddable players allow framing and play with
   audio, and a direct media file can simply be played. This maps a page URL
   to that local, audible form, or null when there is none. Pure. */

export interface MediaEmbed {
  url: string;
  provider: "youtube" | "vimeo" | "file";
  label: string;
}

const YT_ID = /^[\w-]{11}$/;

export function mediaEmbedFor(raw: string): MediaEmbed | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id = "";
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v") ?? "";
    else {
      const m = /^\/(shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname);
      if (m) id = m[2];
    }
  } else if (host === "youtu.be") id = u.pathname.slice(1, 12);
  if (YT_ID.test(id)) {
    const start = Number.parseInt(u.searchParams.get("t") ?? u.searchParams.get("start") ?? "", 10);
    return { url: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1${Number.isFinite(start) && start > 0 ? `&start=${start}` : ""}`, provider: "youtube", label: "YouTube player" };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const m = /\/(?:video\/)?(\d{5,})/.exec(u.pathname);
    if (m) return { url: `https://player.vimeo.com/video/${m[1]}?autoplay=1`, provider: "vimeo", label: "Vimeo player" };
  }
  if (/\.(mp4|webm|ogv|mov|m4v|mp3|m4a|ogg|oga|wav|flac|aac|opus)$/i.test(u.pathname)) {
    return { url: u.toString(), provider: "file", label: "media file" };
  }
  return null;
}
