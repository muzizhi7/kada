# Third-party notices

Kada's LICENSE applies to Kada-owned code and repository-owned character artwork. It does not relicense third-party packages, remote inputs, models or services. Dependencies are installed from the pinned npm lockfile; node_modules is not distributed in the source release.

| Direct runtime dependency | Pinned version | Declared license |
| --- | --- | --- |
| @earendil-works/chord | 1.4.0 | MIT |
| @earendil-works/pi-ai | 1.4.0 | MIT |
| @earendil-works/pi-coding-agent | 1.4.0 | MIT |
| @earendil-works/pi-durable | 1.4.0 | MIT |
| @modelcontextprotocol/sdk | 1.32.2 | MIT |
| jsonc-parser | 3.3.1 | MIT |
| proper-lockfile | 4.1.2 | MIT |
| smol-toml | 1.9.1 | BSD-3-Clause |

The lockfile records declared licenses for transitive packages. Keep their copyright and license files when redistributing installed dependencies; this table is not a replacement for those files. Development-only Python requirements are listed separately in scripts/cases/requirements.txt.

## Acknowledgments and external inputs

- Pi provides the actual model/tool/session/runtime mechanisms. Kada is not endorsed by Pi's maintainers.
- DeepSeek APIs and optional Agent Reach are external network/service integrations with their own terms, credentials and potential fees.
- Experiment preparation scripts can download public NASA/NOAA/Our World in Data inputs and pinned open-source projects. Those inputs retain their upstream licenses and attribution; private download directories and original sessions are excluded from this source release.
- The handover example describes a Click source snapshot; Click is a separate Pallets project. Its source snapshot is not bundled in this repository. Supply the pinned source separately and retain its license when preparing a handover.
- The default Kada C6 concept was developed with AI-assisted image exploration; the shipped character is a native vector implementation maintained in desktop/PetApp.swift. Repository-owned illustrations and screenshots are covered by Kada's MIT license. No model weights or third-party character assets are included.
