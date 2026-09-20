# Changelog

All notable changes to this project are documented in this file.

**This file is generated. Do not edit it.** Release Please rewrites it from the conventional
commit titles that reach master, and a hand-written entry here is overwritten without warning.
Versioning follows [Semantic Versioning](https://semver.org/); see
[CONTRIBUTING.md](CONTRIBUTING.md) for how a title decides the version.

Entries from 1.1.0 and earlier were written by hand and are kept as they were.

## [1.40.2](https://github.com/bardesss/haelan/compare/v1.40.1...v1.40.2) (2026-09-20)


### Bug Fixes

* **test:** close the databases two test files were abandoning ([#300](https://github.com/bardesss/haelan/issues/300)) ([821133a](https://github.com/bardesss/haelan/commit/821133adf79098882462bb917177f390bad2e6e4))

## [1.40.1](https://github.com/bardesss/haelan/compare/v1.40.0...v1.40.1) (2026-09-19)


### Bug Fixes

* **web:** do not hide a card on an exclusion list that has not arrived ([#298](https://github.com/bardesss/haelan/issues/298)) ([7b6fba5](https://github.com/bardesss/haelan/commit/7b6fba5b734e801f735e4a99554884b1198d3050))

## [1.40.0](https://github.com/bardesss/haelan/compare/v1.39.0...v1.40.0) (2026-09-19)


### Features

* a recovery index, haelan's own version of a score no API will hand over ([#296](https://github.com/bardesss/haelan/issues/296)) ([a9e0ab3](https://github.com/bardesss/haelan/commit/a9e0ab35a9814cc6d584b3c73f6ce6331ab2da91))

## [1.39.0](https://github.com/bardesss/haelan/compare/v1.38.1...v1.39.0) (2026-09-19)


### Features

* **web:** a card with nothing to show renders nothing at all ([#293](https://github.com/bardesss/haelan/issues/293)) ([cea5f18](https://github.com/bardesss/haelan/commit/cea5f185a7fa7564f9098e4b00fbabc34aead370))
* **web:** the rebuild notice says how old it is ([#295](https://github.com/bardesss/haelan/issues/295)) ([e664c26](https://github.com/bardesss/haelan/commit/e664c262cff4d73c4ca71654a83cf85431b33143))

## [1.38.1](https://github.com/bardesss/haelan/compare/v1.38.0...v1.38.1) (2026-09-19)


### Bug Fixes

* **core,web:** say when a rebuild produced nothing, and stop the hook-timeout flake ([#291](https://github.com/bardesss/haelan/issues/291)) ([d1c8c38](https://github.com/bardesss/haelan/commit/d1c8c383ed290c16525c03925c8b9c9164392741))

## [1.38.0](https://github.com/bardesss/haelan/compare/v1.37.2...v1.38.0) (2026-09-19)


### Features

* **core,server,web:** a person whose rebuild failed is finally told so ([#285](https://github.com/bardesss/haelan/issues/285)) ([e91fe35](https://github.com/bardesss/haelan/commit/e91fe352db91ccf4b843fef75531deb49737403c))
* **core:** one unreplayable page costs that page, not the whole archive ([#288](https://github.com/bardesss/haelan/issues/288)) ([7dfd3ad](https://github.com/bardesss/haelan/commit/7dfd3adc43bf6598a6031eaf94f120807abd4f61))
* **web:** one control row line on a phone, and sync moved to the shell ([#287](https://github.com/bardesss/haelan/issues/287)) ([c95c811](https://github.com/bardesss/haelan/commit/c95c81167dcd78b3be20b149d71cacf4c3fa19b8))

## [1.37.2](https://github.com/bardesss/haelan/compare/v1.37.1...v1.37.2) (2026-09-18)


### Bug Fixes

* **core:** insert a day's derived rows in chunks, not one statement each ([#283](https://github.com/bardesss/haelan/issues/283)) ([37fb04e](https://github.com/bardesss/haelan/commit/37fb04e9cefba3392fc139b4b2308def9b2c05fc)), closes [#275](https://github.com/bardesss/haelan/issues/275)

## [1.37.1](https://github.com/bardesss/haelan/compare/v1.37.0...v1.37.1) (2026-09-18)


### Bug Fixes

* **core:** prepare the sample upsert once instead of once per row ([#281](https://github.com/bardesss/haelan/issues/281)) ([efad634](https://github.com/bardesss/haelan/commit/efad6344c208965f67fd5b66dbdab58485e8da68)), closes [#275](https://github.com/bardesss/haelan/issues/275)

## [1.37.0](https://github.com/bardesss/haelan/compare/v1.36.1...v1.37.0) (2026-09-18)


### Features

* say which of your sources wins a contested day ([#279](https://github.com/bardesss/haelan/issues/279)) ([7ec89bb](https://github.com/bardesss/haelan/commit/7ec89bb6375ae4794f12f35575782d35bde4c601))

## [1.36.1](https://github.com/bardesss/haelan/compare/v1.36.0...v1.36.1) (2026-09-18)


### Bug Fixes

* **core:** a body that repeats a session no longer costs a person their rebuild ([#277](https://github.com/bardesss/haelan/issues/277)) ([cacc225](https://github.com/bardesss/haelan/commit/cacc22525405aa70c19e56a0240b465915e8c976))

## [1.36.0](https://github.com/bardesss/haelan/compare/v1.35.0...v1.36.0) (2026-09-17)


### Features

* the members card says who the admin is, and how each member is doing ([#271](https://github.com/bardesss/haelan/issues/271)) ([f59d2fa](https://github.com/bardesss/haelan/commit/f59d2fa4ca1b237c2ebb5df59b05dfb631a9ca2e))

## [1.35.0](https://github.com/bardesss/haelan/compare/v1.34.0...v1.35.0) (2026-09-17)


### Features

* tell an admin when a newer release is out, if they ask for it ([#269](https://github.com/bardesss/haelan/issues/269)) ([d30ddff](https://github.com/bardesss/haelan/commit/d30ddff0398bbfb87174a2b9ed1d95e2b33d13ef))

## [1.34.0](https://github.com/bardesss/haelan/compare/v1.33.0...v1.34.0) (2026-09-17)


### Features

* **web:** settings split into your account and this instance ([#267](https://github.com/bardesss/haelan/issues/267)) ([e9efd2c](https://github.com/bardesss/haelan/commit/e9efd2ca1251c368b031d3e40d59a9682ad5a8a0))

## [1.33.0](https://github.com/bardesss/haelan/compare/v1.32.0...v1.33.0) (2026-09-17)


### Features

* **web:** a readable sessions list, a fitted sleep axis, and a rail that follows the pages you keep ([#265](https://github.com/bardesss/haelan/issues/265)) ([97b4d53](https://github.com/bardesss/haelan/commit/97b4d53132e3f8305448df474f3d2f0b54262ef5))

## [1.32.0](https://github.com/bardesss/haelan/compare/v1.31.0...v1.32.0) (2026-09-17)


### Features

* **web:** a day tile says how that day sat against your own usual ([#262](https://github.com/bardesss/haelan/issues/262)) ([3072a58](https://github.com/bardesss/haelan/commit/3072a586d950f8c748478b10011bf31e79a6e22a))

## [1.31.0](https://github.com/bardesss/haelan/compare/v1.30.0...v1.31.0) (2026-09-17)


### Features

* **web:** the project links and the version move into a Settings card ([#260](https://github.com/bardesss/haelan/issues/260)) ([e014c2a](https://github.com/bardesss/haelan/commit/e014c2ad5e8451194cc29da69b7ff87c1589cdf1))

## [1.30.0](https://github.com/bardesss/haelan/compare/v1.29.0...v1.30.0) (2026-09-16)


### Features

* **web:** tiles that are tiles, lists that stop at a measure, and figures that say what they are ([#258](https://github.com/bardesss/haelan/issues/258)) ([00a8855](https://github.com/bardesss/haelan/commit/00a88553749dbe84c0ef141a599e92ba14eabdda))

## [1.29.0](https://github.com/bardesss/haelan/compare/v1.28.0...v1.29.0) (2026-09-16)


### Features

* the records a session holds, and the device that set a record ([#256](https://github.com/bardesss/haelan/issues/256)) ([a4d6515](https://github.com/bardesss/haelan/commit/a4d6515b0f725d29b6172df7ba9baf7e027cb11d))

## [1.28.0](https://github.com/bardesss/haelan/compare/v1.27.0...v1.28.0) (2026-09-16)


### Features

* the all-time page, and what only the archive can answer ([#253](https://github.com/bardesss/haelan/issues/253)) ([6da32e3](https://github.com/bardesss/haelan/commit/6da32e383a8efaa16f15ef23d7f0c14d69a30212))

## [1.27.0](https://github.com/bardesss/haelan/compare/v1.26.1...v1.27.0) (2026-09-15)


### Features

* a source that stopped inside the range says so on the page ([#250](https://github.com/bardesss/haelan/issues/250)) ([52c754b](https://github.com/bardesss/haelan/commit/52c754b7676555b706f0f9f12834298c2564745b))

## [1.26.1](https://github.com/bardesss/haelan/compare/v1.26.0...v1.26.1) (2026-09-15)


### Bug Fixes

* the staleness read leaves the hot path, and reaches an agent ([#248](https://github.com/bardesss/haelan/issues/248)) ([3431c3d](https://github.com/bardesss/haelan/commit/3431c3d455d3099418675bb11a4490f10d4e3f2e))

## [1.26.0](https://github.com/bardesss/haelan/compare/v1.25.0...v1.26.0) (2026-09-15)


### Features

* a source that has stopped reporting says so ([#246](https://github.com/bardesss/haelan/issues/246)) ([517c2da](https://github.com/bardesss/haelan/commit/517c2dad7345a80391d3fbe5a472c4ce73a5aaa6))

## [1.25.0](https://github.com/bardesss/haelan/compare/v1.24.0...v1.25.0) (2026-09-15)


### Features

* the maintenance card can download the latest backup ([#243](https://github.com/bardesss/haelan/issues/243)) ([bc990ad](https://github.com/bardesss/haelan/commit/bc990adcb285ae28c75fc70a05ee4da673452454))

## [1.24.0](https://github.com/bardesss/haelan/compare/v1.23.0...v1.24.0) (2026-09-15)


### Features

* **web:** M7, the small screen ([#241](https://github.com/bardesss/haelan/issues/241)) ([e411caa](https://github.com/bardesss/haelan/commit/e411caaa1d26055536182fa48dd660b0f57a179e))

## [1.23.0](https://github.com/bardesss/haelan/compare/v1.22.3...v1.23.0) (2026-09-14)


### Features

* the landing page's screenshots open full size, and cannot drift from the README ([#239](https://github.com/bardesss/haelan/issues/239)) ([4e5e65b](https://github.com/bardesss/haelan/commit/4e5e65b9ccd7b6d89dfde36102cadd4300dd600b))

## [1.22.3](https://github.com/bardesss/haelan/compare/v1.22.2...v1.22.3) (2026-09-14)


### Bug Fixes

* better-sqlite3 13, and the Node floor that actually made it fail ([#234](https://github.com/bardesss/haelan/issues/234)) ([5d39052](https://github.com/bardesss/haelan/commit/5d39052867a7435de7b9809b808161f3e984165c))

## [1.22.2](https://github.com/bardesss/haelan/compare/v1.22.1...v1.22.2) (2026-09-14)


### Bug Fixes

* the container asks testers to report somewhere that carries the script ([#235](https://github.com/bardesss/haelan/issues/235)) ([b962b4a](https://github.com/bardesss/haelan/commit/b962b4a71aab36b2c67bf9654fcfe5235ae28cc0))

## [1.22.1](https://github.com/bardesss/haelan/compare/v1.22.0...v1.22.1) (2026-09-14)


### Bug Fixes

* the LXC data directory takes the name upstream documents ([#231](https://github.com/bardesss/haelan/issues/231)) ([e966c42](https://github.com/bardesss/haelan/commit/e966c429ac34ac41e02c7f44e709df36b5a9f900))

## [1.22.0](https://github.com/bardesss/haelan/compare/v1.21.3...v1.22.0) (2026-09-14)


### Features

* haelan installs into a Proxmox LXC without Docker ([#229](https://github.com/bardesss/haelan/issues/229)) ([d957716](https://github.com/bardesss/haelan/commit/d957716893fc51e04aea734de354eb7566f02567))

## [1.21.3](https://github.com/bardesss/haelan/compare/v1.21.2...v1.21.3) (2026-09-14)


### Bug Fixes

* **site:** the hero wash and the cap band run edge to edge ([#226](https://github.com/bardesss/haelan/issues/226)) ([6aaafeb](https://github.com/bardesss/haelan/commit/6aaafeb6345bfd600856149e616808120b431ef9))

## [1.21.2](https://github.com/bardesss/haelan/compare/v1.21.1...v1.21.2) (2026-09-14)


### Bug Fixes

* **demo:** let the demo's clock run, so charts draw ([#224](https://github.com/bardesss/haelan/issues/224)) ([4bbc84c](https://github.com/bardesss/haelan/commit/4bbc84c29104f5b8d3e99c2adef60301e4362cf9))

## [1.21.1](https://github.com/bardesss/haelan/compare/v1.21.0...v1.21.1) (2026-09-14)


### Bug Fixes

* **site:** link the demo from the front page, and make its deep links work ([#222](https://github.com/bardesss/haelan/issues/222)) ([4d14d0f](https://github.com/bardesss/haelan/commit/4d14d0fbd9cf7dd8b664c74b484942a7f225439f))

## [1.21.0](https://github.com/bardesss/haelan/compare/v1.20.0...v1.21.0) (2026-09-14)


### Features

* **demo:** a browsable demo, recorded from the real app and served as static files ([#215](https://github.com/bardesss/haelan/issues/215)) ([7c62858](https://github.com/bardesss/haelan/commit/7c62858773bfe021cb49e5b0815130495c910c7b))

## [1.20.0](https://github.com/bardesss/haelan/compare/v1.19.0...v1.20.0) (2026-09-13)


### Features

* **site:** a landing page, published to GitHub Pages on every release ([#212](https://github.com/bardesss/haelan/issues/212)) ([b716193](https://github.com/bardesss/haelan/commit/b7161938a9ea4e2933806d41ef055a98ab7a9762))

## [1.19.0](https://github.com/bardesss/haelan/compare/v1.18.0...v1.19.0) (2026-09-13)


### Features

* **web:** four bands of active minutes that actually partition the day ([#210](https://github.com/bardesss/haelan/issues/210)) ([5f3a891](https://github.com/bardesss/haelan/commit/5f3a89141662344b76a19711b22ed5a1b943797d))

## [1.18.0](https://github.com/bardesss/haelan/compare/v1.17.1...v1.18.0) (2026-09-13)


### Features

* how many backups to keep, and how often, become settings rather than variables ([#205](https://github.com/bardesss/haelan/issues/205)) ([b2cd24b](https://github.com/bardesss/haelan/commit/b2cd24bb17f4db3537c2227975944f4ced980946)), closes [#150](https://github.com/bardesss/haelan/issues/150)

## [1.17.1](https://github.com/bardesss/haelan/compare/v1.17.0...v1.17.1) (2026-09-13)


### Bug Fixes

* **server:** resolving a session stops being a write, so a boot rebuild cannot take the instance down ([#206](https://github.com/bardesss/haelan/issues/206)) ([47ac840](https://github.com/bardesss/haelan/commit/47ac840787cb17b64633e7ffc000212170cc009b))

## [1.17.0](https://github.com/bardesss/haelan/compare/v1.16.1...v1.17.0) (2026-09-13)


### Features

* **web:** a weekly cardio load target and an acute to chronic workload ratio ([#203](https://github.com/bardesss/haelan/issues/203)) ([4f9b5a9](https://github.com/bardesss/haelan/commit/4f9b5a9095c575e977cdb901e2d3b7ac3e3dcf58))


### Bug Fixes

* **test:** flush() waits on progress, and can tell a settled page from one that never started ([#202](https://github.com/bardesss/haelan/issues/202)) ([b914b71](https://github.com/bardesss/haelan/commit/b914b71e511487a79708746de2a0b81d14cdfbfd)), closes [#193](https://github.com/bardesss/haelan/issues/193)

## [1.16.1](https://github.com/bardesss/haelan/compare/v1.16.0...v1.16.1) (2026-09-13)


### Bug Fixes

* **test:** the trace card waits for the fallback, not for flush()'s guess ([#199](https://github.com/bardesss/haelan/issues/199)) ([ca4d6cb](https://github.com/bardesss/haelan/commit/ca4d6cbb8545d279a8b1b7843464b49c1de3207c))

## [1.16.0](https://github.com/bardesss/haelan/compare/v1.15.3...v1.16.0) (2026-09-13)


### Features

* Haelan's own cardio load, and the per-split heart rate the watch never wrote ([#191](https://github.com/bardesss/haelan/issues/191)) ([dd4a15a](https://github.com/bardesss/haelan/commit/dd4a15afc2d8837d2a46f5a94bf8294572354192))


### Bug Fixes

* **test:** the source-trace tests wait for the render, not for flush()'s guess ([#197](https://github.com/bardesss/haelan/issues/197)) ([d13c41c](https://github.com/bardesss/haelan/commit/d13c41c647568e7439d60054220367c69955074d))

## [1.15.3](https://github.com/bardesss/haelan/compare/v1.15.2...v1.15.3) (2026-09-13)


### Bug Fixes

* **web:** active zone minutes are a score, so stop calling them minutes ([#195](https://github.com/bardesss/haelan/issues/195)) ([04ec6b0](https://github.com/bardesss/haelan/commit/04ec6b0cb5ec2a386b0b53b3c1a377478ee3f18c))

## [1.15.2](https://github.com/bardesss/haelan/compare/v1.15.1...v1.15.2) (2026-09-13)


### Bug Fixes

* **server:** the boot rebuild runs in its own process, not a thread that can crash the server ([#187](https://github.com/bardesss/haelan/issues/187)) ([7c57c15](https://github.com/bardesss/haelan/commit/7c57c15c64393dbd9b1561a35b605c64d3c14521))

## [1.15.1](https://github.com/bardesss/haelan/compare/v1.15.0...v1.15.1) (2026-09-13)


### Bug Fixes

* **ci:** cut the release with the workflow's own token, not the PAT ([#184](https://github.com/bardesss/haelan/issues/184)) ([dd66111](https://github.com/bardesss/haelan/commit/dd6611155283ad12aac217b39937e39a450332e0))
* **ci:** the release is a draft until its image is on the registry ([#183](https://github.com/bardesss/haelan/issues/183)) ([1b6e3ec](https://github.com/bardesss/haelan/commit/1b6e3ec154402f46d3f57418caa921dca8bfc149))

## [1.15.0](https://github.com/bardesss/haelan/compare/v1.14.1...v1.15.0) (2026-09-13)


### Features

* **web:** distance and floors draw a labelled bar chart, side by side ([#181](https://github.com/bardesss/haelan/issues/181)) ([bf5620c](https://github.com/bardesss/haelan/commit/bf5620c3675c26bccb8d192716bf15b8d52e19f9))

## [1.14.1](https://github.com/bardesss/haelan/compare/v1.14.0...v1.14.1) (2026-09-13)


### Bug Fixes

* **test:** the workout and night pages wait for a condition, not for flush()'s guess ([#180](https://github.com/bardesss/haelan/issues/180)) ([5345129](https://github.com/bardesss/haelan/commit/534512982d53bb63980246b03c17ad9367378baa))
* **web:** the sparkline tooltip escapes the note a reader typed ([#177](https://github.com/bardesss/haelan/issues/177)) ([c5e2ee3](https://github.com/bardesss/haelan/commit/c5e2ee3d4830c1cfb58daca41e8bd534294d151f))
* **web:** the workout page's zone chart draws something ([#179](https://github.com/bardesss/haelan/issues/179)) ([39e4f72](https://github.com/bardesss/haelan/commit/39e4f72be118a48fe0f4e1db615324185244333d))

## [1.14.0](https://github.com/bardesss/haelan/compare/v1.13.0...v1.14.0) (2026-09-13)


### Features

* **web:** the night page, and M8 closes with it ([#174](https://github.com/bardesss/haelan/issues/174)) ([f2bd818](https://github.com/bardesss/haelan/commit/f2bd818d0938e0955fb1ff7d0351ee082c2db3e0))

## [1.13.0](https://github.com/bardesss/haelan/compare/v1.12.1...v1.13.0) (2026-09-12)


### Features

* **web:** the workout page, and the exclude control no browser could reach ([#172](https://github.com/bardesss/haelan/issues/172)) ([8fd36d5](https://github.com/bardesss/haelan/commit/8fd36d5b7f6c2392ac82b2293b3e82f49b4b9f93))

## [1.12.1](https://github.com/bardesss/haelan/compare/v1.12.0...v1.12.1) (2026-09-12)


### Bug Fixes

* the projection sweep was deleting live queries' databases ([#167](https://github.com/bardesss/haelan/issues/167)) ([67e770a](https://github.com/bardesss/haelan/commit/67e770a8ef8ec8108479a2a13a81ca8a9822acb0))

## [1.12.0](https://github.com/bardesss/haelan/compare/v1.11.0...v1.12.0) (2026-09-12)


### Features

* sql_query, over a projection nothing else is in ([#164](https://github.com/bardesss/haelan/issues/164)) ([79e8b2d](https://github.com/bardesss/haelan/commit/79e8b2d2a3e89c80fa5c589a8b60080c855d4720))


### Bug Fixes

* the M4 review's findings — a killable sandbox, bounded results, and writes that cannot fail a read ([#166](https://github.com/bardesss/haelan/issues/166)) ([241dd1a](https://github.com/bardesss/haelan/commit/241dd1a5cb51a857de05fb136d2676c5d461d384))

## [1.11.0](https://github.com/bardesss/haelan/compare/v1.10.0...v1.11.0) (2026-09-12)


### Features

* **web:** the mark is drawn from the tokens, and worn everywhere ([#162](https://github.com/bardesss/haelan/issues/162)) ([32d27ec](https://github.com/bardesss/haelan/commit/32d27ece7036fb4cb6f5171de761c9e387039308))

## [1.10.0](https://github.com/bardesss/haelan/compare/v1.9.1...v1.10.0) (2026-09-12)


### Features

* the agent surface over HTTP, behind a token that belongs to one person ([#159](https://github.com/bardesss/haelan/issues/159)) ([df7a3e2](https://github.com/bardesss/haelan/commit/df7a3e241e8b93df507484947a840b7881669558))

## [1.9.1](https://github.com/bardesss/haelan/compare/v1.9.0...v1.9.1) (2026-09-12)


### Bug Fixes

* **test:** the MCP stdio test stops timing startup with a reply's budget ([#160](https://github.com/bardesss/haelan/issues/160)) ([d3f5b8f](https://github.com/bardesss/haelan/commit/d3f5b8f6320f6bb358897e60e41c5fcbdd677ef8))
* **web:** chart tooltips escape the text a reader typed ([#157](https://github.com/bardesss/haelan/issues/157)) ([7f29b78](https://github.com/bardesss/haelan/commit/7f29b78dc097607b3d11690b7e8f7581a45c5be5))

## [1.9.0](https://github.com/bardesss/haelan/compare/v1.8.1...v1.9.0) (2026-09-12)


### Features

* **web:** every chart says which day and what value, on hover ([#154](https://github.com/bardesss/haelan/issues/154)) ([82e758d](https://github.com/bardesss/haelan/commit/82e758d48d911d268ae32da9909bbbc1d39a4a35))


### Bug Fixes

* **test:** charts stop animating in tests, so flush() stops waiting them out ([#153](https://github.com/bardesss/haelan/issues/153)) ([ab7faa3](https://github.com/bardesss/haelan/commit/ab7faa32ebfd6838358f82fac8a07d8cf5502fe1))

## [1.8.1](https://github.com/bardesss/haelan/compare/v1.8.0...v1.8.1) (2026-09-12)


### Bug Fixes

* **server:** the TOOLS.md drift test compares content, not line endings ([#151](https://github.com/bardesss/haelan/issues/151)) ([911f69e](https://github.com/bardesss/haelan/commit/911f69e667c39cf4705884420362796fc3ed5b8e))

## [1.8.0](https://github.com/bardesss/haelan/compare/v1.7.1...v1.8.0) (2026-09-12)


### Features

* **web:** settings puts its narrow sections side by side ([#148](https://github.com/bardesss/haelan/issues/148)) ([8c82dd0](https://github.com/bardesss/haelan/commit/8c82dd07b5b212c2ddf0dbc3d9ded49e36633c67))

## [1.7.1](https://github.com/bardesss/haelan/compare/v1.7.0...v1.7.1) (2026-09-12)


### Bug Fixes

* the password form on the profile card says where it begins ([#146](https://github.com/bardesss/haelan/issues/146)) ([7570de9](https://github.com/bardesss/haelan/commit/7570de96f7cb52db29046e2b9dcd6767ba094d08))

## [1.7.0](https://github.com/bardesss/haelan/compare/v1.6.0...v1.7.0) (2026-09-12)


### Features

* **server:** thirteen tools and an MCP server on stdio ([#144](https://github.com/bardesss/haelan/issues/144)) ([0faee79](https://github.com/bardesss/haelan/commit/0faee798f8caa33c9fe36524843fb8e199b97b2e))

## [1.6.0](https://github.com/bardesss/haelan/compare/v1.5.0...v1.6.0) (2026-09-11)


### Features

* **core:** the detail page spine, and the archive re-mapped onto it ([#141](https://github.com/bardesss/haelan/issues/141)) ([3eb7ff7](https://github.com/bardesss/haelan/commit/3eb7ff7dcd016a79163bf12e9f63dc0ec45f1e42))

## [1.5.0](https://github.com/bardesss/haelan/compare/v1.4.0...v1.5.0) (2026-09-11)


### Features

* **core:** the query layer M4a's agent surfaces read through ([#138](https://github.com/bardesss/haelan/issues/138)) ([73de283](https://github.com/bardesss/haelan/commit/73de28374a0af671d341cccb0a5369520c590e86))

## [1.4.0](https://github.com/bardesss/haelan/compare/v1.3.0...v1.4.0) (2026-09-11)


### Features

* an account's name, username, timezone and password can be changed after it is created ([#136](https://github.com/bardesss/haelan/issues/136)) ([b6153bf](https://github.com/bardesss/haelan/commit/b6153bf6b0325f9abab48bf9ffdb686ff76740f9))


### Bug Fixes

* release-please can find its own releases again, so the version stops being fiction ([#135](https://github.com/bardesss/haelan/issues/135)) ([46660de](https://github.com/bardesss/haelan/commit/46660dedecf07493e2952278236d90b466ce4f4f))

## [1.3.0](https://github.com/bardesss/haelan/compare/v1.2.0...v1.3.0) (2026-09-11)


### Features

* a console tool for the password reset this app has never had ([#131](https://github.com/bardesss/haelan/issues/131)) ([21cdf17](https://github.com/bardesss/haelan/commit/21cdf17e26abdd9bb16d8119751c8e426e6e0005))
* **core:** a browser safe metrics subpath, so pages stop copying the catalogue ([#69](https://github.com/bardesss/haelan/issues/69)) ([24cf29d](https://github.com/bardesss/haelan/commit/24cf29de264b0734ab92843dad7c9cd51693fd19))
* **core:** M1a store, schema, credentials and raw archive ([#12](https://github.com/bardesss/haelan/issues/12)) ([5995f8e](https://github.com/bardesss/haelan/commit/5995f8e7f862c36c6d3c4cdc002b462513917500))
* **core:** M1b API client, catalogue and field mapping ([#14](https://github.com/bardesss/haelan/issues/14)) ([d9f1088](https://github.com/bardesss/haelan/commit/d9f10882d2513db8b4be5cbed04a640d18f611fb))
* **core:** M1c sync engine, day aligned windows and per row sources ([#19](https://github.com/bardesss/haelan/issues/19)) ([885551a](https://github.com/bardesss/haelan/commit/885551a47f34c416572d2d0f03222bcaf5098f56))
* **core:** M2a metric catalogue, daily rollups and the derive queue ([#38](https://github.com/bardesss/haelan/issues/38)) ([21e4801](https://github.com/bardesss/haelan/commit/21e480155b5a25e1e9c743568a815cca269f83bd))
* **core:** M2b source priority, merged daily rows and overrides at derivation ([#45](https://github.com/bardesss/haelan/issues/45)) ([9c5c4fb](https://github.com/bardesss/haelan/commit/9c5c4fbed6aac840b2ee60e6b8b5f2ada1d38e7e))
* **core:** M2c sleep derivation, night assembly and nap detection ([#50](https://github.com/bardesss/haelan/issues/50)) ([182a726](https://github.com/bardesss/haelan/commit/182a726b7e66310084db6b2a6e40e2ff1dd544dd))
* **core:** M2d baselines, insight suppression and the person bound query layer ([#51](https://github.com/bardesss/haelan/issues/51)) ([9be53d1](https://github.com/bardesss/haelan/commit/9be53d1ece4b64784e5eaf6c298ab473925fae88))
* **core:** M2e rebuild from tier 1 with re-resolved source identity ([#55](https://github.com/bardesss/haelan/issues/55)) ([d746833](https://github.com/bardesss/haelan/commit/d7468339f1d4f87505b6a50d81f28f316b948c18))
* M1d wizard, accounts and the setup flow ([#21](https://github.com/bardesss/haelan/issues/21)) ([9254125](https://github.com/bardesss/haelan/commit/92541255a45a1fa510742e3365f78ce4699ee57b))
* **probe:** M0 auth probe, answers scope, field paths and volume ([#11](https://github.com/bardesss/haelan/issues/11)) ([3f17ebc](https://github.com/bardesss/haelan/commit/3f17ebcd9ee35e8c447d6beffaa02e7ed6b35045))
* **server:** M3b-2 HTTP surface, ten person bound reads behind one guard ([#67](https://github.com/bardesss/haelan/issues/67)) ([15c8a8b](https://github.com/bardesss/haelan/commit/15c8a8bf40d92b572d34eee4d0f8473e868e99ce))
* **tokens:** chart tokens with enforced colour blindness and contrast checks ([1f6f468](https://github.com/bardesss/haelan/commit/1f6f4688908c666a0c1a6e156d1ed6e6c010b1d3))
* **tokens:** colour conversion, cvd simulation and contrast ([7bcc2bb](https://github.com/bardesss/haelan/commit/7bcc2bb8b665b3eefd352e3b4bc676f3c9b599f9))
* **tokens:** emit css custom properties for both themes ([36c031c](https://github.com/bardesss/haelan/commit/36c031c41a218be1abdc90190df846715a13dac9))
* **tokens:** primitive and semantic layers for both themes ([800cfc5](https://github.com/bardesss/haelan/commit/800cfc58a5147f35e51e7e0db1bef1dc0be9c5b4))
* **tokens:** raise the type scale floor to 12px ([b0426ac](https://github.com/bardesss/haelan/commit/b0426ac734771b3fac5711b92ef682c955ea4fd1))
* **web:** app shell built from semantic tokens only ([268aa9c](https://github.com/bardesss/haelan/commit/268aa9caa36a37b79e3e2160c41bf19460cf6706))
* **web:** dashboard and sleep reference pages with styling spec ([3e2dd33](https://github.com/bardesss/haelan/commit/3e2dd337201aca16d2b9afc190b6c8850d2aa4ed))
* **web:** deterministic fixtures, sparkline and heart rate range chart ([77d9a8f](https://github.com/bardesss/haelan/commit/77d9a8f34cd75e803f0cb9314ec3acac1034488f))
* **web:** hypnogram, sleep schedule and activity heatmap ([d1dd9a4](https://github.com/bardesss/haelan/commit/d1dd9a4deb60c01d444fd6dcfbda1f515e005796))
* **web:** M3a web foundations, so the reader can get in and the pages have something to stand on ([#64](https://github.com/bardesss/haelan/issues/64)) ([bef38a4](https://github.com/bardesss/haelan/commit/bef38a437513a008cad68899d9e7d65e972924e5))
* **web:** M3d-1 page spine, and the Dashboard reading real data ([#68](https://github.com/bardesss/haelan/issues/68)) ([ff00bed](https://github.com/bardesss/haelan/commit/ff00bed6eb06c6c1d81bf94a5191c1f605f7bca6))
* **web:** M3d-2 Activity, Sleep and Recovery, on one card that cannot lie ([#71](https://github.com/bardesss/haelan/issues/71)) ([bb0eca4](https://github.com/bardesss/haelan/commit/bb0eca4b3409a4c79bfffffcd77ff1569a651a1c))
* **web:** real nav icons, no underline, larger type scale ([ee5eb05](https://github.com/bardesss/haelan/commit/ee5eb05fb3b7e5a1cf95858f7ca72ea406a7242c))
* **web:** rebrand to haelan and finish the app shell ([#10](https://github.com/bardesss/haelan/issues/10)) ([892e291](https://github.com/bardesss/haelan/commit/892e29171da50b9e5157749f2873a05febdc052b))
* **web:** resolve chart colours from tokens at render time ([f975be7](https://github.com/bardesss/haelan/commit/f975be714b5a27a7be3487c88ffba296dd61fbcf))


### Bug Fixes

* close the M2 audit findings before M3 begins ([#62](https://github.com/bardesss/haelan/issues/62)) ([2ad42d4](https://github.com/bardesss/haelan/commit/2ad42d44d09ea61899c14711bf8034cc42aa3e94))
* **core:** reclaim the write-ahead log a rebuild leaves behind ([#102](https://github.com/bardesss/haelan/issues/102)) ([3ba2dc2](https://github.com/bardesss/haelan/commit/3ba2dc255485ec93943ba835ac70a9fa4ddda701))
* **core:** refuse a date the calendar does not have, in all three methods ([#52](https://github.com/bardesss/haelan/issues/52)) ([d390a69](https://github.com/bardesss/haelan/commit/d390a69d43c738309f578df069a575cd0b7383ea))
* **core:** replay archived payloads in the order they were fetched ([#58](https://github.com/bardesss/haelan/issues/58)) ([360e809](https://github.com/bardesss/haelan/commit/360e809f9d123f9f618c0ab967d5c6674b00ebb9))
* make pnpm start mean what the documentation says ([#24](https://github.com/bardesss/haelan/issues/24)) ([3efcf49](https://github.com/bardesss/haelan/commit/3efcf4985beb40f9354582379aed47f41020cd9a))
* raise the Node floor to 22.13, which pnpm 11 requires ([64aea91](https://github.com/bardesss/haelan/commit/64aea91b8acaf8b534a77d2c3c61a9d5f753c6f9))
* run the server on stock Node, and prove it at boot ([#23](https://github.com/bardesss/haelan/issues/23)) ([5660c6f](https://github.com/bardesss/haelan/commit/5660c6fa48d72ea0bd15b401dbd92a5f53804d94))
* **server:** close four setup routes the README already called protected ([#36](https://github.com/bardesss/haelan/issues/36)) ([a6798c7](https://github.com/bardesss/haelan/commit/a6798c7cb62c831ebbc29f6d3f0caf007d143bd8))
* **server:** scope sync status and its event stream to the caller's person ([#66](https://github.com/bardesss/haelan/issues/66)) ([da9e49a](https://github.com/bardesss/haelan/commit/da9e49a0acab0d943c05484a9137d37d89e76707))
* set allowBuilds.esbuild to true for pnpm 11.22 compatibility ([246a4ec](https://github.com/bardesss/haelan/commit/246a4ec580cc79bae5f70623e44d5a56415aa57c))
* **sync:** raise the intraday cap to a year, and make it self-healing ([#28](https://github.com/bardesss/haelan/issues/28)) ([5aa5055](https://github.com/bardesss/haelan/commit/5aa5055d3c5324699197856f1abe5bdad393c764))
* **sync:** repair gaps after downtime, and stop three silent failures ([#31](https://github.com/bardesss/haelan/issues/31)) ([482bfe4](https://github.com/bardesss/haelan/commit/482bfe4b0b81f279c40a14f0288dd62358b3d8c8))
* **sync:** stop the cursor at a response body we cannot read ([#46](https://github.com/bardesss/haelan/issues/46)) ([3d1aac9](https://github.com/bardesss/haelan/commit/3d1aac94f4d8a6b4105523d03e9905f5374b0772))
* the M2e follow ups, plus a shutdown that actually stops ([#56](https://github.com/bardesss/haelan/issues/56)) ([570c698](https://github.com/bardesss/haelan/commit/570c698ca3454262aa6a003509e143a8dc61bb9b))
* the seeded demo directory is gitignored, and its password is typeable ([#128](https://github.com/bardesss/haelan/issues/128)) ([9f40a5a](https://github.com/bardesss/haelan/commit/9f40a5aaa2984aa9062651a1681fb447baa2a0a3))
* three defects found walking the setup flow end to end ([#25](https://github.com/bardesss/haelan/issues/25)) ([926b616](https://github.com/bardesss/haelan/commit/926b6163481c8448f5b32c5ab8a54ee7d29c54f1))
* **tokens:** close the accessibility gaps the token suite could not see ([#30](https://github.com/bardesss/haelan/issues/30)) ([9ad9cd7](https://github.com/bardesss/haelan/commit/9ad9cd74c207d6d7b1aa2c4d75234b15c7db9fc2))
* **tokens:** renumber primitives by lightness, add sequential scale, widen contrast cover ([a1fe658](https://github.com/bardesss/haelan/commit/a1fe65848cfae3cd92a14195549f5fa3d33e7418))
* **tokens:** resolve --text- prefix collision between colours and type scale ([d6e0346](https://github.com/bardesss/haelan/commit/d6e0346f960fda092687965215f01d094274c527))
* update Node engine to &gt;=22.6 and add pnpm configuration ([93d418b](https://github.com/bardesss/haelan/commit/93d418bcbddc804062313a936e923d53a2010863))
* **web,tokens:** separate delta direction from tone, distinguish no-data from grid ([2e139cd](https://github.com/bardesss/haelan/commit/2e139cd2be17dd1c57b4af13a52781e4135d4d5f))
* **web:** anchor excluded HR markers at actual mean, guard tooltip nulls ([9c0de62](https://github.com/bardesss/haelan/commit/9c0de6212175f710900125828e16b9ca5c4817f4))
* **web:** extract night-mark decision to a testable pure function ([91d71a0](https://github.com/bardesss/haelan/commit/91d71a0de013126865058424ab8cda3bb6ac1717))
* **web:** make flush() wait on isFetching, not a wall clock budget ([#70](https://github.com/bardesss/haelan/issues/70)) ([e9cfa64](https://github.com/bardesss/haelan/commit/e9cfa64e437bf4ce44815e87a0919c9e64a7ac89))
* **web:** one author for token names, shared chart base, accessible charts ([0b90358](https://github.com/bardesss/haelan/commit/0b903583c5550e35fff5fd87f0148768023fef35))
* **web:** render naps within the schedule axis, use chartVar for stage swatches, memoise heatmap layout ([7459bd3](https://github.com/bardesss/haelan/commit/7459bd31215da0c8b46a7b2b8f7241d26a538703))
* **web:** restrict visualMap to the heatmap series, add a page smoke test ([a5db9dd](https://github.com/bardesss/haelan/commit/a5db9dda7012c564e7d02fab28037e6e26db3a50))
* **web:** the collapsed rail names its icons, and the stepper names the period instead of spelling its bounds ([#84](https://github.com/bardesss/haelan/issues/84)) ([cef9629](https://github.com/bardesss/haelan/commit/cef96293960a7d1c87290471b57fc710eba42049))


### Performance Improvements

* **core:** one date formatter per timezone, not one per probe ([#110](https://github.com/bardesss/haelan/issues/110)) ([40b6321](https://github.com/bardesss/haelan/commit/40b632196bff912ba86a7a6be604ee2874d61783))
* **sync:** sprint the recent window, and cap the types that cost the most ([#26](https://github.com/bardesss/haelan/issues/26)) ([55a0352](https://github.com/bardesss/haelan/commit/55a03520a38b883abd59c72a101f63f28450ab4a))

## [1.2.0](https://github.com/bardesss/haelan/compare/v1.1.1...v1.2.0) (2026-09-11)


### Features

* a console tool for the password reset this app has never had ([#131](https://github.com/bardesss/haelan/issues/131)) ([21cdf17](https://github.com/bardesss/haelan/commit/21cdf17e26abdd9bb16d8119751c8e426e6e0005))
* **core:** a browser safe metrics subpath, so pages stop copying the catalogue ([#69](https://github.com/bardesss/haelan/issues/69)) ([24cf29d](https://github.com/bardesss/haelan/commit/24cf29de264b0734ab92843dad7c9cd51693fd19))
* **core:** M1a store, schema, credentials and raw archive ([#12](https://github.com/bardesss/haelan/issues/12)) ([5995f8e](https://github.com/bardesss/haelan/commit/5995f8e7f862c36c6d3c4cdc002b462513917500))
* **core:** M1b API client, catalogue and field mapping ([#14](https://github.com/bardesss/haelan/issues/14)) ([d9f1088](https://github.com/bardesss/haelan/commit/d9f10882d2513db8b4be5cbed04a640d18f611fb))
* **core:** M1c sync engine, day aligned windows and per row sources ([#19](https://github.com/bardesss/haelan/issues/19)) ([885551a](https://github.com/bardesss/haelan/commit/885551a47f34c416572d2d0f03222bcaf5098f56))
* **core:** M2a metric catalogue, daily rollups and the derive queue ([#38](https://github.com/bardesss/haelan/issues/38)) ([21e4801](https://github.com/bardesss/haelan/commit/21e480155b5a25e1e9c743568a815cca269f83bd))
* **core:** M2b source priority, merged daily rows and overrides at derivation ([#45](https://github.com/bardesss/haelan/issues/45)) ([9c5c4fb](https://github.com/bardesss/haelan/commit/9c5c4fbed6aac840b2ee60e6b8b5f2ada1d38e7e))
* **core:** M2c sleep derivation, night assembly and nap detection ([#50](https://github.com/bardesss/haelan/issues/50)) ([182a726](https://github.com/bardesss/haelan/commit/182a726b7e66310084db6b2a6e40e2ff1dd544dd))
* **core:** M2d baselines, insight suppression and the person bound query layer ([#51](https://github.com/bardesss/haelan/issues/51)) ([9be53d1](https://github.com/bardesss/haelan/commit/9be53d1ece4b64784e5eaf6c298ab473925fae88))
* **core:** M2e rebuild from tier 1 with re-resolved source identity ([#55](https://github.com/bardesss/haelan/issues/55)) ([d746833](https://github.com/bardesss/haelan/commit/d7468339f1d4f87505b6a50d81f28f316b948c18))
* M1d wizard, accounts and the setup flow ([#21](https://github.com/bardesss/haelan/issues/21)) ([9254125](https://github.com/bardesss/haelan/commit/92541255a45a1fa510742e3365f78ce4699ee57b))
* **probe:** M0 auth probe, answers scope, field paths and volume ([#11](https://github.com/bardesss/haelan/issues/11)) ([3f17ebc](https://github.com/bardesss/haelan/commit/3f17ebcd9ee35e8c447d6beffaa02e7ed6b35045))
* **server:** M3b-2 HTTP surface, ten person bound reads behind one guard ([#67](https://github.com/bardesss/haelan/issues/67)) ([15c8a8b](https://github.com/bardesss/haelan/commit/15c8a8bf40d92b572d34eee4d0f8473e868e99ce))
* **tokens:** chart tokens with enforced colour blindness and contrast checks ([1f6f468](https://github.com/bardesss/haelan/commit/1f6f4688908c666a0c1a6e156d1ed6e6c010b1d3))
* **tokens:** colour conversion, cvd simulation and contrast ([7bcc2bb](https://github.com/bardesss/haelan/commit/7bcc2bb8b665b3eefd352e3b4bc676f3c9b599f9))
* **tokens:** emit css custom properties for both themes ([36c031c](https://github.com/bardesss/haelan/commit/36c031c41a218be1abdc90190df846715a13dac9))
* **tokens:** primitive and semantic layers for both themes ([800cfc5](https://github.com/bardesss/haelan/commit/800cfc58a5147f35e51e7e0db1bef1dc0be9c5b4))
* **tokens:** raise the type scale floor to 12px ([b0426ac](https://github.com/bardesss/haelan/commit/b0426ac734771b3fac5711b92ef682c955ea4fd1))
* **web:** app shell built from semantic tokens only ([268aa9c](https://github.com/bardesss/haelan/commit/268aa9caa36a37b79e3e2160c41bf19460cf6706))
* **web:** dashboard and sleep reference pages with styling spec ([3e2dd33](https://github.com/bardesss/haelan/commit/3e2dd337201aca16d2b9afc190b6c8850d2aa4ed))
* **web:** deterministic fixtures, sparkline and heart rate range chart ([77d9a8f](https://github.com/bardesss/haelan/commit/77d9a8f34cd75e803f0cb9314ec3acac1034488f))
* **web:** hypnogram, sleep schedule and activity heatmap ([d1dd9a4](https://github.com/bardesss/haelan/commit/d1dd9a4deb60c01d444fd6dcfbda1f515e005796))
* **web:** M3a web foundations, so the reader can get in and the pages have something to stand on ([#64](https://github.com/bardesss/haelan/issues/64)) ([bef38a4](https://github.com/bardesss/haelan/commit/bef38a437513a008cad68899d9e7d65e972924e5))
* **web:** M3d-1 page spine, and the Dashboard reading real data ([#68](https://github.com/bardesss/haelan/issues/68)) ([ff00bed](https://github.com/bardesss/haelan/commit/ff00bed6eb06c6c1d81bf94a5191c1f605f7bca6))
* **web:** M3d-2 Activity, Sleep and Recovery, on one card that cannot lie ([#71](https://github.com/bardesss/haelan/issues/71)) ([bb0eca4](https://github.com/bardesss/haelan/commit/bb0eca4b3409a4c79bfffffcd77ff1569a651a1c))
* **web:** real nav icons, no underline, larger type scale ([ee5eb05](https://github.com/bardesss/haelan/commit/ee5eb05fb3b7e5a1cf95858f7ca72ea406a7242c))
* **web:** rebrand to haelan and finish the app shell ([#10](https://github.com/bardesss/haelan/issues/10)) ([892e291](https://github.com/bardesss/haelan/commit/892e29171da50b9e5157749f2873a05febdc052b))
* **web:** resolve chart colours from tokens at render time ([f975be7](https://github.com/bardesss/haelan/commit/f975be714b5a27a7be3487c88ffba296dd61fbcf))


### Bug Fixes

* close the M2 audit findings before M3 begins ([#62](https://github.com/bardesss/haelan/issues/62)) ([2ad42d4](https://github.com/bardesss/haelan/commit/2ad42d44d09ea61899c14711bf8034cc42aa3e94))
* **core:** reclaim the write-ahead log a rebuild leaves behind ([#102](https://github.com/bardesss/haelan/issues/102)) ([3ba2dc2](https://github.com/bardesss/haelan/commit/3ba2dc255485ec93943ba835ac70a9fa4ddda701))
* **core:** refuse a date the calendar does not have, in all three methods ([#52](https://github.com/bardesss/haelan/issues/52)) ([d390a69](https://github.com/bardesss/haelan/commit/d390a69d43c738309f578df069a575cd0b7383ea))
* **core:** replay archived payloads in the order they were fetched ([#58](https://github.com/bardesss/haelan/issues/58)) ([360e809](https://github.com/bardesss/haelan/commit/360e809f9d123f9f618c0ab967d5c6674b00ebb9))
* make pnpm start mean what the documentation says ([#24](https://github.com/bardesss/haelan/issues/24)) ([3efcf49](https://github.com/bardesss/haelan/commit/3efcf4985beb40f9354582379aed47f41020cd9a))
* raise the Node floor to 22.13, which pnpm 11 requires ([64aea91](https://github.com/bardesss/haelan/commit/64aea91b8acaf8b534a77d2c3c61a9d5f753c6f9))
* run the server on stock Node, and prove it at boot ([#23](https://github.com/bardesss/haelan/issues/23)) ([5660c6f](https://github.com/bardesss/haelan/commit/5660c6fa48d72ea0bd15b401dbd92a5f53804d94))
* **server:** close four setup routes the README already called protected ([#36](https://github.com/bardesss/haelan/issues/36)) ([a6798c7](https://github.com/bardesss/haelan/commit/a6798c7cb62c831ebbc29f6d3f0caf007d143bd8))
* **server:** scope sync status and its event stream to the caller's person ([#66](https://github.com/bardesss/haelan/issues/66)) ([da9e49a](https://github.com/bardesss/haelan/commit/da9e49a0acab0d943c05484a9137d37d89e76707))
* set allowBuilds.esbuild to true for pnpm 11.22 compatibility ([246a4ec](https://github.com/bardesss/haelan/commit/246a4ec580cc79bae5f70623e44d5a56415aa57c))
* **sync:** raise the intraday cap to a year, and make it self-healing ([#28](https://github.com/bardesss/haelan/issues/28)) ([5aa5055](https://github.com/bardesss/haelan/commit/5aa5055d3c5324699197856f1abe5bdad393c764))
* **sync:** repair gaps after downtime, and stop three silent failures ([#31](https://github.com/bardesss/haelan/issues/31)) ([482bfe4](https://github.com/bardesss/haelan/commit/482bfe4b0b81f279c40a14f0288dd62358b3d8c8))
* **sync:** stop the cursor at a response body we cannot read ([#46](https://github.com/bardesss/haelan/issues/46)) ([3d1aac9](https://github.com/bardesss/haelan/commit/3d1aac94f4d8a6b4105523d03e9905f5374b0772))
* the M2e follow ups, plus a shutdown that actually stops ([#56](https://github.com/bardesss/haelan/issues/56)) ([570c698](https://github.com/bardesss/haelan/commit/570c698ca3454262aa6a003509e143a8dc61bb9b))
* the seeded demo directory is gitignored, and its password is typeable ([#128](https://github.com/bardesss/haelan/issues/128)) ([9f40a5a](https://github.com/bardesss/haelan/commit/9f40a5aaa2984aa9062651a1681fb447baa2a0a3))
* three defects found walking the setup flow end to end ([#25](https://github.com/bardesss/haelan/issues/25)) ([926b616](https://github.com/bardesss/haelan/commit/926b6163481c8448f5b32c5ab8a54ee7d29c54f1))
* **tokens:** close the accessibility gaps the token suite could not see ([#30](https://github.com/bardesss/haelan/issues/30)) ([9ad9cd7](https://github.com/bardesss/haelan/commit/9ad9cd74c207d6d7b1aa2c4d75234b15c7db9fc2))
* **tokens:** renumber primitives by lightness, add sequential scale, widen contrast cover ([a1fe658](https://github.com/bardesss/haelan/commit/a1fe65848cfae3cd92a14195549f5fa3d33e7418))
* **tokens:** resolve --text- prefix collision between colours and type scale ([d6e0346](https://github.com/bardesss/haelan/commit/d6e0346f960fda092687965215f01d094274c527))
* update Node engine to &gt;=22.6 and add pnpm configuration ([93d418b](https://github.com/bardesss/haelan/commit/93d418bcbddc804062313a936e923d53a2010863))
* **web,tokens:** separate delta direction from tone, distinguish no-data from grid ([2e139cd](https://github.com/bardesss/haelan/commit/2e139cd2be17dd1c57b4af13a52781e4135d4d5f))
* **web:** anchor excluded HR markers at actual mean, guard tooltip nulls ([9c0de62](https://github.com/bardesss/haelan/commit/9c0de6212175f710900125828e16b9ca5c4817f4))
* **web:** extract night-mark decision to a testable pure function ([91d71a0](https://github.com/bardesss/haelan/commit/91d71a0de013126865058424ab8cda3bb6ac1717))
* **web:** make flush() wait on isFetching, not a wall clock budget ([#70](https://github.com/bardesss/haelan/issues/70)) ([e9cfa64](https://github.com/bardesss/haelan/commit/e9cfa64e437bf4ce44815e87a0919c9e64a7ac89))
* **web:** one author for token names, shared chart base, accessible charts ([0b90358](https://github.com/bardesss/haelan/commit/0b903583c5550e35fff5fd87f0148768023fef35))
* **web:** render naps within the schedule axis, use chartVar for stage swatches, memoise heatmap layout ([7459bd3](https://github.com/bardesss/haelan/commit/7459bd31215da0c8b46a7b2b8f7241d26a538703))
* **web:** restrict visualMap to the heatmap series, add a page smoke test ([a5db9dd](https://github.com/bardesss/haelan/commit/a5db9dda7012c564e7d02fab28037e6e26db3a50))
* **web:** the collapsed rail names its icons, and the stepper names the period instead of spelling its bounds ([#84](https://github.com/bardesss/haelan/issues/84)) ([cef9629](https://github.com/bardesss/haelan/commit/cef96293960a7d1c87290471b57fc710eba42049))


### Performance Improvements

* **core:** one date formatter per timezone, not one per probe ([#110](https://github.com/bardesss/haelan/issues/110)) ([40b6321](https://github.com/bardesss/haelan/commit/40b632196bff912ba86a7a6be604ee2874d61783))
* **sync:** sprint the recent window, and cap the types that cost the most ([#26](https://github.com/bardesss/haelan/issues/26)) ([55a0352](https://github.com/bardesss/haelan/commit/55a03520a38b883abd59c72a101f63f28450ab4a))

## [1.1.1](https://github.com/bardesss/haelan/compare/v1.1.0...v1.1.1) (2026-09-11)


### Bug Fixes

* the seeded demo directory is gitignored, and its password is typeable ([#128](https://github.com/bardesss/haelan/issues/128)) ([9f40a5a](https://github.com/bardesss/haelan/commit/9f40a5aaa2984aa9062651a1681fb447baa2a0a3))

## [1.1.0] - 2026-09-11

### Added

- A supported way to change the instance's address after setup, under Settings for an admin. Until
  now the address was written once by the setup wizard and could not be changed again, which is
  exactly the wrong time to find that out: moving an instance to a new hostname is what a household
  does after it is running, not before. The panel shows the redirect URI the new address produces
  and says to register it in the Google Cloud console before saving, because a stale address does
  not interrupt syncing and so gives no sign anything is wrong until the next consent, which is
  adding a household member or reconnecting an account whose access was revoked.

### Fixed

- An instance address entered without a scheme is stored as the `https` it was validated as. Both
  the setup wizard and the new settings panel read a bare `homelab.example.com` as https and accept
  it, then stored it verbatim, which built a redirect URI with no scheme at all for Google to
  reject and printed that same broken string as the one to register. The address that gets stored
  is now the one that was validated.

## [1.0.0] - 2026-09-11

First release. A self-hosted dashboard and local mirror for your own health data, built on the
Google Health API v4, for one household running one instance.

### Added

- A complete local mirror of the account's Google Health history in one SQLite file: the
  compressed raw archive, everything derived from it, and every note, event and override,
  surviving Google's retention windows and kept at minute-level resolution for intraday samples
  that the API itself does not retain.
- Eight dashboard pages: Dashboard, Activity, Sleep, Recovery, Health, Weight, Nutrition and
  Notes. Sleep is derived with stage durations, nap detection and efficiency computed from our
  own segments rather than passed through from the source; Activity carries a heatmap, a workout
  list and an intraday chart; Health covers resting heart rate, HRV and SpO2 with its confidence
  interval; Weight tracks a trend; Nutrition explains, rather than fakes, that the household has
  never logged food and the API's `Food` type carries no timestamp to file a meal under. English
  and Dutch throughout.
- Personal baselines: a reading is shown against the person's own rolling 60 day baseline, and a
  baseline built from too few days is flagged as thin rather than presented as settled.
- Period-over-period insight cards that withhold themselves, each with its own stated reason,
  when the data behind them is too thin to say anything.
- Daily notes and typed events (illness, travel, alcohol, medication, injury, and any other kind
  a person names), so a change in a metric can be checked against what else was going on that day.
- Corrections applied at derivation time rather than by rewriting history: an override excludes a
  bad reading (a glitching strap reporting 210 bpm) from what gets derived, and the raw archived
  payload is never modified, so removing the override restores the original value exactly.
- Household multi-user support: an admin invites a member, the member chooses their own password,
  and each person connects their own Google account and picks which data types get fetched for
  them, seeing only their own data.
- A guided setup wizard that walks through creating a Google Cloud project and OAuth client,
  prints the exact values to paste, and asks which data types to fetch and how far back to
  backfill.
- A daily backup: a compacted copy of the database, integrity-checked and row-counted before it
  is called a backup, with a configurable number kept.
- An automatic upgrade path: a schema migration that changes how data is derived rebuilds the
  affected person's rows from the raw archive rather than leaving old and new derivations side by
  side, and a boot-time reclaim hands freed database pages back to the filesystem once enough of
  them accumulate.
- A demo data seed (`scripts/seed-demo.mjs`) that writes a year of generated history into an
  empty data directory and leaves the setup wizard already finished, for trying the dashboard
  without a Google account.
- A Docker image built for both `linux/amd64` and `linux/arm64`, booted on both architectures
  before every publish, deployable with an eight-line `compose.yaml` that needs no editing.

### Security

- Stored Google credentials are encrypted at rest under a key kept outside the database and
  deliberately excluded from backups, so a backup copied off the machine never carries the
  credentials needed to decrypt itself.
