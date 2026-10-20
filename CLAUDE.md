# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

모든 답변은 한국어로 한다.

## WHY — 이 Agent 팀의 목표

Solution PE Server SSD의 주간 업무 **"ID 필드 검증 및 모호한 부분 문의"**(주 1회, 1회 약 2일)를 Agent 팀이 수행하게 한다.

SSD에서 읽은 NVMe Identify 필드 값을 NVMe Spec · Spec Gap · 제품 사양과 대조해 **Pass / Fail / 검토 필요**로 판정한다. 그리고 Fail 원인 분석과 모호한 항목의 문의 초안까지 만들어, 사람은 **결과 검토와 문의 발송 여부 결정**만 하도록 한다.

## WHAT

### 입력 자료

| 자료 | 위치 (실습) |
|---|---|
| nvme-cli 출력 로그 (`id-ctrl` / `id-ns`, 검증 대상) | `data/nvme_id_ctrl.log`, `data/nvme_id_ns.log` |
| NVMe Spec 문서 | `data/NVM-Express-Base-Specification-Revision-2.1-*.md`, `data/NVM-Express-NVM-Command-Set-Specification-Revision-1.1-*.md` |
| Spec Gap 문서 (Spec과 차이 나는 정책) | `data/spec_gap.xlsx` |
| 사내 Confluence 문서 (제품 사양) | 실무: Confluence MCP / 실습: `data/product_spec_confluence.txt` |

- `data/`의 로그·Spec Gap·제품 사양은 실습용 가상 자료(가상 제품 VSSD-X100)다.

### Sub Agent와 역할 (`.claude/agents/`)

| Task | Sub Agent | 역할 |
|---|---|---|
| 2-a | `nvme-spec-expected-gen` | NVMe Spec 기준 필드별 기대값·근거 정리 |
| 2-a-E | `nvme-spec-expected-eval` | 2-a 결과를 Spec 원문과 대조해 PASS / FAIL |
| 2-b | `spec-gap-expected-gen` | Spec Gap 기준 제품 정책 기대값·근거 정리 |
| 2-b-E | `spec-gap-expected-eval` | 2-b 결과를 Spec Gap 원문과 대조해 PASS / FAIL |
| 2-c | `product-spec-expected-gen` | Confluence 제품 사양을 필드 값으로 변환·근거 정리 |
| 2-c-E | `product-spec-expected-eval` | 2-c 결과를 Confluence 원문과 대조해 PASS / FAIL |
| 4 | `fail-analysis` | Fail 항목 원인·영향도·조치 제안, 전체 종합 의견 |
| 5 | `review-inquiry-writer` | 검토 필요 항목 사유·문의 대상·문의 초안 |

세부 입력·업무 기준·결과물 형식은 각 지시서에 있다.

### 결과물 위치

| 결과물 | 위치 |
|---|---|
| Task 간 중간 결과 (JSON) | `output/` (`actual_values.json`, `expected_*.json`, `eval/eval_2*.json`, `judgement.json`, `fail_analysis.json`, `review_items.json`) |
| 최종 결과물: 대시보드(요약) + 엑셀(필드별 상세) | 코드 6이 생성 (코드 6은 미구현, 저장 위치 미정) |
| 최종 결과물 구조 샘플 | `reference/example.html` |

최종 결과물 구성:
- **Pass/Fail 현황:** 필드별 판정과 건수·비율
- **검토 필요사항:** 항목, 사유, 문의 대상, 문의 초안
- **결과 및 분석:** Fail 원인 분석, 영향도·조치 제안, 전체 종합 의견

## HOW

### 확정 Workflow (`workflow.md`, 시각화: `my-agent-team.html`)

```
[코드 1] 로그 파싱 → 필드별 실제값
   ├─ [2-a Gen ⇄ 2-a-E] ─┐
   ├─ [2-b Gen ⇄ 2-b-E] ─┼─ Parallel A (④)
   └─ [2-c Gen ⇄ 2-c-E] ─┘
[코드 3] 기대값·실제값 비교 → 필드별 판정
   └─ Router: Pass → 코드 6 / Fail → AI 4 / 검토 필요 → AI 5   (AI 4·5는 Parallel B)
[코드 6] 대시보드 · 엑셀 생성
[사람 7] 결과 검토 · 문의 발송 여부 결정
```

- **Gen / Eval:** Eval이 FAIL을 내면 같은 갈래의 Gen이 수정합니다. 최대 2회까지 반복하고, 그래도 FAIL인 필드는 '검토 필요'로 표시한 뒤 코드 3으로 진행합니다.
- **Router 예외:** 검토 필요가 0건이면 AI 5를 호출하지 않습니다. Fail이 0건이면 AI 4는 종합 의견만 작성합니다.

### 위임 방식

- **코드 Task(1, 3, 6):** 메인 세션이 `code/`의 Node.js 스크립트를 실행한다. 이 PC에는 Python이 없다.
  - `node code/01_parse_nvme_cli.js`: Task 1 (구현됨)
  - 코드 3과 코드 6은 아직 구현되지 않았다.
  - `node code/xlsx_to_json.js <xlsx>`: 2-b와 2-b-E가 Spec Gap을 읽을 때 쓰는 도구이며, Workflow Task가 아니다.
- **AI Task:** 해당 Sub Agent에 위임한다. 입력 경로를 넘기면 결과를 `output/`에 저장한다.
- **Parallel 갈래:** 같은 Parallel의 갈래는 동시에 위임하고, 모든 갈래가 끝난 뒤 다음 Task로 넘어간다.
- **Gen / Eval 재실행:** Evaluator의 FAIL 결과(문제 필드·사유)를 같은 갈래 Gen에 전달해 다시 위임한다. 반복 횟수는 Workflow가 관리한다.

### 팀 공통 규칙

- **역할 범위:** 각 Agent는 자기 역할만 수행하고, 다른 Agent의 역할을 하지 않는다.
  - Pass/Fail 판정은 코드 3만 한다.
  - 문의 발송 결정은 사람 7만 한다.
- **Evaluator:** 결과물을 직접 수정하지 않고, 문제 필드와 사유만 전달한다.
- **근거와 추측:** 근거 문서에 없는 값·담당자·날짜를 추측해 만들지 않는다. 확정할 수 없으면 `tbd` / '정의 없음' / '미지정'으로 남긴다.
- **결과 파일 형식:** 단계 간 키를 맞춘다.
  - 구조 이름: `Identify Controller` / `Power State Descriptor` / `Identify Namespace` / `LBA Format`
  - 필드 식별: `structure` + `cli_name`
  - `expected_*.json` 3개는 같은 키 구성을 쓴다.
- **설계 변경:** `업무설계서.md`와 `workflow.md`는 사용자가 확인하기 전에는 수정하지 않는다. 새 Task, Sub Agent, 기준값을 임의로 추가하지 않는다.
- **실습 자료:** 실제 회사명·담당자·사내 데이터를 쓰지 않는다.
