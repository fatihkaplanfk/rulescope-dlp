# Benchmark environment audit (SAUCIS reviewer request)

Date of audit: 2026-10-07. Scope: the hardware and software environment in which the
**published** controlled-benchmark and SPEDIA replay results (`results/`, committed on
2026-08-12) were produced.

## Ground rules

- The workstation used for this audit (Windows 11, used for the R1.3 validation reruns) is **not**
  the original experiment environment. Its hardware is not reported here as the original one.
- Nothing is inferred about the original environment from later reruns.
- A field without a primary record is marked **unknown** or **self-reported only**.

## 1. Sources examined

| Source | Contains environment information? |
|---|---|
| `results/raw/run_n*_seed*.json` (50 files) | No. Fields: size, seed, samples, finding ids, `elapsed_ms`, `rss_mb`, precision/recall/F1. No OS, CPU, Node, host or timestamp field. |
| `results/benchmark_runs.csv`, `results/benchmark_summary.csv` | No. Timing, RSS and metrics only. |
| `results/spedia_formal_findings.json` | No. Dataset summary, findings and `elapsed_ms` only. |
| `experiments/run-benchmark.js`, `experiments/benchmark-worker.js`, `experiments/run-spedia-replay.js` | No environment capture. Execution order can be read from the code (see item 9). |
| `README.md`, `data/README.md`, `CHANGELOG.md`, `CITATION.cff` | No hardware information. `package.json` requires Node `>=20`. |
| `package-lock.json` (repository and `PolicyLint-DLP-v0.2.1-GitHub-Package.zip`) | `z3-solver` resolved to **4.16.0** in both. |
| Execution logs (`*.log`), CI configuration (`.github/`, `*.yml`) | **None exist** in the repository or the package ZIP. |
| Git history | 2 commits (2026-08-12 11:56 and 16:05 +0300). No environment metadata. |
| Manuscript `03_PolicyLint_DLP_SAUCIS_Author.tex` and `PolicyLint_DLP_SAUCIS_.docx` (Materials and Methods) | Yes, as prose written by the authors: "shared virtualized environment exposing nine virtual CPUs based on Intel Xeon Platinum 8573C processors, 15 GiB of RAM, Linux 6.18 x86-64, Node.js 24.14.0, and z3-solver 4.16.0. Runs were performed sequentially…" |

**Key finding:** apart from the z3-solver version (lockfile) and execution order (source code),
every environment detail rests only on the manuscript's own statement. The artifact contains no
machine-generated record (e.g. `os.cpus()`, `/proc/cpuinfo`, `uname -a`, `node --version` or
`lscpu` output) captured at run time that could confirm it.

## 2. Field-by-field status

| # | Field | Value | Status | Verification source |
|---:|---|---|---|---|
| 1 | Cloud / infrastructure provider | **unknown** | not recorded | No artifact names a provider. The CPU SKU is also sold in public cloud offerings (e.g. Azure Dsv6 [1]), but a CPU model does not identify the provider, so none is claimed. |
| 2 | VM / instance type | **unknown** | not recorded | No artifact names an instance type. Nine vCPUs is not a standard size of the commonly listed general-purpose families. This suggests a container or cgroup CPU quota inside a larger VM, but it cannot be confirmed. |
| 3 | CPU model | Intel Xeon Platinum 8573C | self-reported only | Manuscript text. No run-time CPU record exists in the artifact. |
| 4a | CPU nominal (base) frequency | **unknown** in the artifact | not recorded | The 8573C is a custom ("C") SKU without a public Intel ARK page found in this audit. A reseller listing gives 2.3 GHz base [2], which is not an authoritative source. Not stated in the manuscript. |
| 4b | Vendor-documented all-core turbo | 3.0 GHz (vendor documentation for Azure v6 VMs using this CPU [1]) | published spec for the CPU model, **not** observed in the experiment | It applies to the experiment only if the host ran this SKU under the same configuration, which is unknown. |
| 4c | Observed operating frequency during runs | **unknown** | not recorded | No frequency sampling or `/proc/cpuinfo` snapshot was taken. In a shared VM the guest-visible MHz value is unreliable anyway. |
| 5 | vCPUs and RAM | 9 vCPUs, 15 GiB | self-reported only | Manuscript text. Not recorded at run time. |
| 6 | Host tenancy | "shared virtualized environment" | self-reported, qualitative | Manuscript text. Dedicated vs. shared host and noisy-neighbour control cannot be confirmed: **unknown** beyond the authors' statement. |
| 7 | Operating system | Linux 6.18, x86-64 (kernel version only; distribution unknown) | self-reported only | Manuscript text. |
| 8a | Node.js version | 24.14.0 | self-reported only | Manuscript text. `package.json` only requires `>=20`. The audit workstation also runs 24.14.0, but that is not evidence for the original runs. |
| 8b | z3-solver version | 4.16.0 | **verified** | `package-lock.json` pins `z3-solver` 4.16.0 (integrity `sha512-vWT+I5Yz…`), identically in the repository and the submitted package ZIP. `npm ci` installs exactly this version. |
| 9 | Sequential execution | Yes at application level | **verified from code**, partly | `run-benchmark.js` runs one worker process per (size, seed) with blocking `spawnSync` in nested loops, so no two benchmark runs overlap. `run-spedia-replay.js` analyses variants in a sequential `for` loop with `await`. The z3-solver WebAssembly build has an internal pthread pool (`api.em.PThread` is terminated by the worker), so engine-internal threading cannot be excluded from the code. Whether other workloads ran on the host at the same time is **unknown**. |

## 3. Consequences for the reported runtimes

- The runtime ratio between the SMT analysis and the random baseline was measured in the same
  process and machine, and benchmark runs were run back-to-back. Shared-host noise therefore
  affects both arms, although not necessarily equally.
- Absolute milliseconds (e.g. 888.5 ms at 1,000 rules) cannot be tied to a documented instance
  type, clock frequency or tenancy, and should be read as indicative.
- The manuscript already discloses environmental noise (Threats to Validity: "shared virtualized
  environment … include environmental noise").

## 4. Recommendations (not carried out)

1. Do not add provider, instance type, base frequency or tenancy details to the paper unless an
   original record turns up (cloud console history, billing record, a saved shell session).
2. For future runs, have `run-benchmark.js` write an `environment.json` with `os.cpus()`,
   `os.totalmem()`, `os.release()`, `process.versions` and the z3-solver version. This is a
   suggestion only; no code was changed in this audit.
3. If the reviewer insists on absolute times, re-run the benchmark on a documented machine and
   report it **as a new, separately labelled run**, keeping the original numbers.

## 5. Suggested manuscript text

> The experiments were executed in a shared virtualized Linux environment (kernel 6.18,
> x86-64) that exposed nine virtual CPUs reported as Intel Xeon Platinum 8573C and 15 GiB of RAM,
> using Node.js 24.14.0 and z3-solver 4.16.0 (pinned in the artifact's lockfile). The cloud
> provider, instance type, host tenancy and the effective clock frequency during the runs were
> not recorded and are therefore not reported. Benchmark runs were executed one at a time, each
> in a separate process, with no application-level parallelism. Because other tenants may have
> shared the host, absolute times should be interpreted as indicative. The SMT-versus-baseline
> comparison is less sensitive to this, because both were measured in the same process under the
> same conditions.

## References

[1] Microsoft, "Dsv6 sizes series" (Azure documentation), describing the 5th-generation Intel
Xeon Platinum 8573C with 3.0 GHz all-core turbo: https://docs.azure.cn/en-us/virtual-machines/sizes/general-purpose/dsv6-series

[2] Reseller listing giving 2.3 GHz base for the 8573C (not authoritative): https://www.ebay.de/itm/388476161574
