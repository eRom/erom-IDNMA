# Changelog

## [0.7.1](https://github.com/eRom/erom-IDNMA/compare/v0.7.0...v0.7.1) (2026-11-07)


### Bug Fixes

* **config:** force subagents onto the engine model off Anthropic ([#12](https://github.com/eRom/erom-IDNMA/issues/12)) ([a93e540](https://github.com/eRom/erom-IDNMA/commit/a93e540f2195ab88b962f7b9957b713d29c3c077))

## [0.7.0](https://github.com/eRom/erom-IDNMA/compare/v0.6.0...v0.7.0) (2026-11-07)


### Features

* **pi:** run Pi under an understudy on the peer bus ([#10](https://github.com/eRom/erom-IDNMA/issues/10)) ([49e3c55](https://github.com/eRom/erom-IDNMA/commit/49e3c55aa8ad9cfb2533177362c11b77739c4f2f))

## [0.6.0](https://github.com/eRom/erom-IDNMA/compare/v0.5.0...v0.6.0) (2026-11-05)


### Features

* **cli:** add idnma configure ([cda7483](https://github.com/eRom/erom-IDNMA/commit/cda74833a1e91919e43994092388128295bea0e9))
* **configure:** agent and engine structure operations ([b3454f9](https://github.com/eRom/erom-IDNMA/commit/b3454f94e8a743b4c9ddba5134f05f79e605cc45))
* **configure:** atomic config write with change detection ([760a2f4](https://github.com/eRom/erom-IDNMA/commit/760a2f424c1a7cdbf99aec6ab7cebe946d0a3196))
* **configure:** create flag on variables, display path and canRevert in the view ([01414aa](https://github.com/eRom/erom-IDNMA/commit/01414aaea167a988a3c33891ec06d2f920c38384))
* **configure:** engine field operations ([83a007b](https://github.com/eRom/erom-IDNMA/commit/83a007b54974f361318c4503c1115f6d0b1f7993))
* **configure:** interactive page with the application design system ([06a7eda](https://github.com/eRom/erom-IDNMA/commit/06a7eda97d380eb8112d7ed30048aa565951e5b6))
* **configure:** local server with token, origin and idle guards ([924ba04](https://github.com/eRom/erom-IDNMA/commit/924ba0415e0fc93153b64dd9edd044f6c27d42f4))
* **configure:** name the engine env button Add Environment variable ([0236976](https://github.com/eRom/erom-IDNMA/commit/02369763bf68e26676fd9e8723fe10dfddc6042b))
* **configure:** preset operations and built-in presets ([d3ad12f](https://github.com/eRom/erom-IDNMA/commit/d3ad12f9e4108ee1a206246b5c682b9ade73765e))
* **configure:** read config document into a view ([a4e1bb0](https://github.com/eRom/erom-IDNMA/commit/a4e1bb01a1dc6beab35a1bacc5dcbaa39a442cb9))
* **configure:** render the configure page ([a114824](https://github.com/eRom/erom-IDNMA/commit/a11482423b225cb22c581b7b7f52f04be2b8cb78))
* **configure:** sort lists alphabetically, group agents by harness, show Used by as badges ([1d900a8](https://github.com/eRom/erom-IDNMA/commit/1d900a8146b05bfa5ee334d72e811a029b819931))
* **configure:** validation shared with idnma run ([8169886](https://github.com/eRom/erom-IDNMA/commit/8169886b4770bd87c5e331608dc29c670483af79))
* **install:** leave ~/.idnma.yml to idnma configure ([76831a0](https://github.com/eRom/erom-IDNMA/commit/76831a07ee2104eb4f29d32687e21e89ca1f3674))


### Bug Fixes

* **cli:** align configure help line, accept --help anywhere in configure args ([565e96e](https://github.com/eRom/erom-IDNMA/commit/565e96eb69040d3fade9cb13637a14e4c78bdf02))
* **configure:** count only the primary button and keep pending inputs when the window loses focus ([498a7ff](https://github.com/eRom/erom-IDNMA/commit/498a7ffda4bd450e65f1fd48830b0c2391592adc))
* **configure:** create sections with a Scalar key so later lookups and field order work ([0825efc](https://github.com/eRom/erom-IDNMA/commit/0825efcc491b407f12918920d1cb2a6142da9137))
* **configure:** display path, canRevert, first-agent screen, neutral tokens, harness chevron, DS nits ([915b288](https://github.com/eRom/erom-IDNMA/commit/915b2880ad0f63298cf8d6aba245558064ceb547))
* **configure:** guard env anchors on removal, no line wrapping, anthropic means no proxy ([c64e36a](https://github.com/eRom/erom-IDNMA/commit/c64e36ad2a11a20297a981eeb44efc9337ef596f))
* **configure:** keep focus on the right grouped row, pick the delete neighbour in displayed order ([b4338c5](https://github.com/eRom/erom-IDNMA/commit/b4338c58c9545a5af0a4df6fe0d2a34c1d737d7b))
* **configure:** one issue for anchored numbers, refuse renaming to a built-in of another kind ([5c5d717](https://github.com/eRom/erom-IDNMA/commit/5c5d7176d1593ded53a6af6f415d12075d6ea135))
* **configure:** refuse self-referencing aliases, English server log, keep env refs verbatim in AC-8 ([03a720f](https://github.com/eRom/erom-IDNMA/commit/03a720f8edb636d8b18edb9c8e3c8bf69078f5d1))
* **configure:** return unmodified text byte for byte, match built-ins by anchor ([58e17c2](https://github.com/eRom/erom-IDNMA/commit/58e17c265f034f1792683731ea585371aad982f6))
* **configure:** ring the right env input, escape table test, accessible names, folded env ([24d90f2](https://github.com/eRom/erom-IDNMA/commit/24d90f2ec41812871f04188935c733e691f508f1))
* **configure:** save after typing, clicks after typing, add variable guard; page logic extracted and tested ([5568674](https://github.com/eRom/erom-IDNMA/commit/55686740c3cc85a561006f0a3c6a04d7fd5c72b3))
* **configure:** save through symlinks, recheck the file before the rename ([03bf0d0](https://github.com/eRom/erom-IDNMA/commit/03bf0d0badb40708d194a7c6822bb58d3aa32a3c))
* **configure:** setting a value to itself rewrites nothing, built-in preset names keep their kind ([d264625](https://github.com/eRom/erom-IDNMA/commit/d264625f726530c5accf31e5d3a44669c6b457a6))
* **configure:** typing in a clean file enables Save, one click saves it ([d3b73b6](https://github.com/eRom/erom-IDNMA/commit/d3b73b6371fe051111f5527168bff3e4db446ecd))

## [0.5.0](https://github.com/eRom/erom-IDNMA/compare/v0.4.0...v0.5.0) (2026-11-05)


### Features

* **config:** fill missing model tier vars from model: for proxied claude engines ([3fb29b2](https://github.com/eRom/erom-IDNMA/commit/3fb29b2c8f94edae0e6e95ade4c41cbe155be087))

## [0.4.0](https://github.com/eRom/erom-IDNMA/compare/v0.3.0...v0.4.0) (2026-11-03)


### Features

* **linux:** support Linux for Claude Code and Codex ([#6](https://github.com/eRom/erom-IDNMA/issues/6)) ([ec21fc6](https://github.com/eRom/erom-IDNMA/commit/ec21fc6d0230e9e82235471c2d22d0ddef76261c))

## [0.3.0](https://github.com/eRom/erom-IDNMA/compare/v0.2.0...v0.3.0) (2026-11-03)


### Features

* **install:** one-line installer served at erom.cloud ([#4](https://github.com/eRom/erom-IDNMA/issues/4)) ([56375ff](https://github.com/eRom/erom-IDNMA/commit/56375ff6ad2ba440d2155ade720a05741a2e51ee))

## [0.2.0](https://github.com/eRom/erom-IDNMA/compare/v0.1.0...v0.2.0) (2026-11-03)


### Features

* **cli:** add idnma --version ([#2](https://github.com/eRom/erom-IDNMA/issues/2)) ([2862206](https://github.com/eRom/erom-IDNMA/commit/28622068240ecec752c09362be67829ac26ab4a5))
