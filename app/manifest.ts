import type { MetadataRoute } from "next";

/** Lets Chrome on the phone add Paisa to the home screen as its own app window. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Paisa", short_name: "Paisa", description: "Personal money tracker",
    start_url: "/", display: "standalone", background_color: "#111110", theme_color: "#111110",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
