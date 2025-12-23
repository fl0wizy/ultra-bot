# ultra-bot — 이더리움 자동 송금 봇

내가 개인키를 보유한 지갑의 네이티브 코인(ETH 등)을, 내가 지정한 수신 주소로
**자동 송금**하는 Node.js 봇입니다. Ethereum 및 EVM 호환 체인(Monad 등)에서 동작합니다.

지갑에 잔액이 들어오면 감지해서 즉시 보내거나, cron으로 정기 송금하거나,
특정 시각에 1회 예약 송금할 수 있습니다.

## 사용 범위

이 도구는 **본인이 개인키를 보유한 지갑 → 본인이 지정한 주소**로의 송금 자동화를 목적으로 합니다.

- 여러 지갑에 흩어진 잔액을 메인 지갑 하나로 모으는 정산(consolidation)
- 개인 지갑 → 본인 거래소 입금 주소로의 정기 이체
- 테스트넷 파우셋/보상 수령 지갑의 잔액을 운영 지갑으로 자동 이관

타인의 지갑이나 본인 소유가 아닌 키를 대상으로 한 사용은 의도된 용도가 아닙니다.

## 동작 모드

| 모드 | 설명 | 진입점 |
|---|---|---|
| 감지 송금 (기본) | 시작 시 잔액이 있으면 즉시 송금하고, 이후 설정한 시간 동안 잔액을 폴링해 입금이 감지되면 송금 | `monitorBalance()` |
| 반복 송금 | cron 표현식으로 주기 실행 | `scheduleRecurring()` |
| 1회 예약 송금 | 지정한 UTC 시각에 한 번만 실행 | `scheduleOneTime()` |

기본 실행은 감지 송금 모드입니다. 나머지 두 모드는 `main()`에서 해당 함수를 호출하도록 바꿔 사용합니다.

## 구현 포인트

단순 `sendTransaction` 래퍼가 아니라, 체인 혼잡 상황에서 송금이 실제로 들어가도록 다음을 구현했습니다.

- **멀티 RPC 병렬 브로드캐스트** — 서명된 트랜잭션을 등록된 모든 RPC에 동시에 던지고
  `Promise.race`로 가장 먼저 `transactionHash`를 돌려준 응답만 채택합니다.
  개별 RPC 실패는 reject하지 않고 무시하므로 노드 하나가 죽어도 전송이 막히지 않습니다.
- **receipt 비대기 전송** — 블록 confirm을 기다리지 않고 `transactionHash` 이벤트에서 즉시 반환해,
  폴링 루프가 다음 사이클로 바로 복귀합니다.
- **가스 가격 정책** — 네트워크 조회값 × 배수를 적용하고 하한/상한으로 clamp,
  결과를 짧게 캐싱합니다. 조회에 타임아웃을 걸고 실패 시 `캐시값 → 기본값` 순으로 폴백합니다.
- **nonce 로컬 관리** — `pending` 기준으로 nonce를 한 번 받아온 뒤 낙관적으로 증가시켜
  매 송금마다 RPC를 다시 때리지 않습니다. `nonce` / `replacement` / `higher priority` 계열
  에러를 감지하면 네트워크에서 재동기화합니다.
- **전송액 계산** — `전송액 = 현재 잔액 − 예상 가스비 − 유지 잔액(reserve)`.
  reserve를 남겨 다음 트랜잭션의 가스비가 고갈되지 않게 합니다.
- **중복 송금 방지** — 전송 중 플래그와 "잔액이 실제로 증가했는가" 검증을 함께 사용해
  같은 잔액에 대해 트랜잭션이 두 번 나가지 않도록 합니다.
- **실패 격리** — 송금 단계의 예외를 상위로 던지지 않습니다. 로그만 남기고 다음 폴링 주기에서
  자연스럽게 재시도되므로 일시적 RPC 장애로 프로세스가 죽지 않습니다.

## 요구 사항

- Node.js v14 이상
- 대상 체인의 RPC 엔드포인트
- 송금 지갑의 개인키, 수신 주소

## 설치

```bash
npm install
```

## 설정

프로젝트 루트에 `.env` 파일을 만듭니다. (`.env`는 `.gitignore`에 포함되어 커밋되지 않습니다.)

```env
# 지갑
PRIVATE_KEY=0x...            # 송금 지갑 개인키
RECIPIENT_ADDRESS=0x...      # 수신 주소 (본인 지갑 또는 본인 거래소 입금 주소)

# 네트워크
NETWORK_MODE=TESTNET
MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz
TESTNET_CHAIN_ID=10143

# 송금
SEND_AMOUNT_MON=1.0          # 송금 실행 판단에 쓰는 최소 금액
MIN_BALANCE_MON=0.01         # 지갑에 남겨둘 유지 잔액

# 가스
GAS_LIMIT=21000
GAS_PRICE_MULTIPLIER=1.5
MIN_GAS_PRICE_GWEI=50
MAX_GAS_PRICE_GWEI=0         # 0 = 상한 없음

# 모니터링
MONITOR_DURATION_MINUTES=30
POLLING_INTERVAL_MS=50
CRON_SCHEDULE=0 15 * * *
```

### 전체 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `NETWORK_MODE` | `TESTNET` | `TESTNET` / `MAINNET` |
| `PRIVATE_KEY` | — | 송금 지갑 개인키 (`0x` 접두어 없어도 됨) |
| `RECIPIENT_ADDRESS` | — | 수신 주소 |
| `GATE_EXCHANGE_ADDRESS` | — | `RECIPIENT_ADDRESS` 미설정 시 대체로 사용되는 거래소 입금 주소 |
| `MONAD_TESTNET_RPC` | `https://testnet-rpc.monad.xyz` | 테스트넷 슬롯의 주 RPC |
| `TESTNET_CHAIN_ID` | `10143` | 테스트넷 슬롯의 chain ID |
| `MONAD_MAINNET_RPC` | `https://rpc.monad.xyz` | 메인넷 슬롯의 주 RPC |
| `MAINNET_CHAIN_ID` | `10144` | 메인넷 슬롯의 chain ID |
| `SEND_AMOUNT_MON` | `1.0` | 송금 실행 판단 기준 금액 (실제 전송액은 잔액 전체 − 가스비 − reserve) |
| `MIN_BALANCE_MON` | `0.01` | 지갑에 남길 유지 잔액 |
| `GAS_LIMIT` | `21000` | 네이티브 전송 가스 한도 |
| `GAS_PRICE_GWEI` | `100` | 가스 조회 완전 실패 시 사용할 기본값 |
| `GAS_PRICE_MULTIPLIER` | `1.5` | 네트워크 가스 가격에 곱할 배수 |
| `MIN_GAS_PRICE_GWEI` | `50` | 가스 가격 하한 |
| `MAX_GAS_PRICE_GWEI` | `0` | 가스 가격 상한 (`0`이면 무제한) |
| `GAS_PRICE_CACHE_DURATION_MS` | `5000` | 가스 가격 캐시 유지 시간 |
| `GAS_PRICE_TIMEOUT_MS` | `3000` | 가스 가격 조회 타임아웃 |
| `MONITOR_DURATION_MINUTES` | `30` | 잔액 모니터링 지속 시간 |
| `POLLING_INTERVAL_MS` | `50` | 잔액 폴링 간격 |
| `CRON_SCHEDULE` | `0 15 * * *` | 반복 송금 모드의 cron 표현식 (UTC) |

## 실행

```bash
npm start
```

로그에 네트워크, 송금 지갑, 수신 주소, 유지 잔액이 먼저 출력됩니다.
**수신 주소를 반드시 확인한 뒤** 잔액을 넣으세요. 기본 동작이 "가스비와 reserve를 뺀 전액 송금"입니다.

## 이더리움에서 쓰기

코드는 `web3.eth`의 표준 API와 legacy `gasPrice` 트랜잭션만 사용하므로 EVM 체인 어디서나 동작합니다.
이더리움을 쓸 때는 테스트넷 슬롯에 이더리움 RPC와 chain ID를 넣으세요.

```env
NETWORK_MODE=TESTNET
MONAD_TESTNET_RPC=https://ethereum-sepolia-rpc.publicnode.com
TESTNET_CHAIN_ID=11155111
MIN_GAS_PRICE_GWEI=1
GAS_PRICE_MULTIPLIER=1.2
```

주의할 점:

- 환경변수 이름의 `MONAD_` 접두어는 최초 구현 대상이 Monad 테스트넷이었던 흔적입니다.
  값 자체는 임의의 EVM RPC를 받습니다. (변수명 일반화는 로드맵)
- `MIN_GAS_PRICE_GWEI` 기본값 `50`은 Monad 기준입니다. **이더리움에서는 반드시 낮추세요.**
  그대로 두면 필요 이상의 가스비를 지불합니다.
- `MAINNET` 모드는 RPC 풀이 아직 테스트넷 목록과 분리되어 있지 않습니다.
  현재는 테스트넷 슬롯에 원하는 체인을 지정하는 방식을 사용하세요. (분리는 로드맵)
- 트랜잭션은 legacy(type 0) 형식입니다. 이더리움에서도 유효하지만 EIP-1559 수수료 최적화는 아닙니다.

## 로드맵

- EIP-1559 수수료(`maxFeePerGas` / `maxPriorityFeePerGas`) 지원
- 네트워크 프로필 분리 — 체인별 RPC 풀 / chain ID / 가스 정책을 설정으로 분리하고 변수명 일반화
- ERC-20 토큰 전송 지원
- receipt 확인 모드 옵션 (전송 후 confirm까지 대기)
- 모듈 분리 및 단위 테스트

## 보안 주의사항

- 개인키를 코드에 하드코딩하지 마세요. `.env` 또는 셸 환경변수를 사용하세요.
- `.env`는 절대 커밋하지 마세요. (`.gitignore`에 등록되어 있습니다)
- 메인넷 실행 전 테스트넷에서 수신 주소·금액·가스 설정을 먼저 검증하세요.
- 전액 송금이 기본 동작이므로 수신 주소 오타는 복구할 수 없습니다.

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 지갑 연결 실패 | `PRIVATE_KEY` 형식 (`0x` 포함/미포함 모두 허용, 길이 확인) |
| 모든 RPC 브로드캐스트 실패 | RPC URL, 네트워크 연결, chain ID 일치 여부 |
| 잔액 부족으로 건너뜀 | 잔액이 `SEND_AMOUNT_MON + MIN_BALANCE_MON`을 넘는지 확인 |
| 가스비 제외 후 전송액 0 | `MIN_BALANCE_MON`을 낮추거나 가스 가격 설정 확인 |
| nonce / replacement 오류 | 같은 지갑을 다른 곳에서 동시에 쓰고 있는지 확인 (봇이 자동 재동기화함) |
| 스케줄이 안 돎 | cron 표현식과 시간대(UTC) 확인 — [crontab.guru](https://crontab.guru/) |

## 참고

- [web3.js 문서](https://web3js.readthedocs.io/)
- [node-cron](https://www.npmjs.com/package/node-cron)

## 라이선스

ISC
