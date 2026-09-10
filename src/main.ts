import { bootApp } from "./app";
import { mountAudioGallery } from "./ui/audio-gallery";
import { mountAssetGallery } from "./render/asset-gallery";
import { mountFixtureGallery } from "./ui/fixture-gallery";
import { mountPlayGallery } from "./ui/play-gallery";

const root = document.getElementById("app");
if (!root) throw new Error("Missing app mount");
const app: HTMLElement = root;

if (new URLSearchParams(location.search).get("qa") === "audio") {
  mountAudioGallery(app);
} else if (new URLSearchParams(location.search).get("qa") === "assets") {
  mountAssetGallery(app);
} else if (new URLSearchParams(location.search).get("qa") === "play") {
  mountPlayGallery(app);
} else if (new URLSearchParams(location.search).get("qa") === "fixture") {
  mountFixtureGallery(app);
} else {
  void bootApp(app);
}
