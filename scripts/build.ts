import { collectNotices, renderNotices } from "./third-party-notices.js";

const result = await Bun.build({
	entrypoints: ["src/cli.ts"],
	outdir: "dist",
	target: "node",
	metafile: true,
});

if (result.metafile === undefined)
	throw new Error("Bun.build returned no metafile");

await Bun.write(
	"dist/THIRD_PARTY_NOTICES.txt",
	renderNotices(
		collectNotices(Object.keys(result.metafile.inputs), process.cwd()),
	),
);
