# Changelog

All notable changes to this project are documented in this file.

**This file is generated. Do not edit it.** Release Please rewrites it from the conventional
commit titles that reach master, and a hand-written entry here is overwritten without warning.
Versioning follows [Semantic Versioning](https://semver.org/); see
[CONTRIBUTING.md](CONTRIBUTING.md) for how a title decides the version.

Entries from 1.1.0 and earlier were written by hand and are kept as they were.

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
