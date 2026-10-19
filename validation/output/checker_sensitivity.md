| Injected fault | Expected affected records | Checker mismatches | Detected |
|---|---:|---:|---|
| baseline (unchanged adapter) | 0 | 0 | yes |
| cloud list without mediafire.com | 200 | 200 | yes |
| internal domain set to dtaa.org | 9,326 | 9,326 | yes |
| sensitivity regex without 'backup' | 421 | 421 | yes |
| file-type map adds .doc -> DOCX | 4,876 | 4,876 | yes |
| device disconnect mapped to DeviceConnect | 2,228 | 2,228 | yes |
| email attachment ignored | 3,429 | 3,429 | yes |
