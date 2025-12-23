const Web3 = require('web3');
const cron = require('node-cron');
require('dotenv').config();

// 네트워크 모드 설정 (TESTNET 또는 MAINNET)
const NETWORK_MODE = (process.env.NETWORK_MODE || 'TESTNET').toUpperCase();

// 테스트넷 설정
const MONAD_TESTNET_RPC = process.env.MONAD_TESTNET_RPC || 'https://testnet-rpc.monad.xyz';
const MONAD_TESTNET_RPCS = [
    process.env.MONAD_TESTNET_RPC || 'https://testnet-rpc.monad.xyz',
    'https://monad-testnet.drpc.org',
    'wss://monad-testnet.drpc.org',
    'https://rpc.ankr.com/monad_testnet',
].filter(Boolean);
const TESTNET_CHAIN_ID = parseInt(process.env.TESTNET_CHAIN_ID || '10143');

// 메인넷 설정 (메인넷 출시 후 업데이트 필요)
const MONAD_MAINNET_RPC = process.env.MONAD_MAINNET_RPC || 'https://rpc.monad.xyz'; // TBA: 메인넷 RPC 주소
const MONAD_MAINNET_RPCS = [
    process.env.MONAD_MAINNET_RPC || 'https://rpc.monad.xyz',
    // 메인넷 RPC 백업 목록 (메인넷 출시 후 추가)
].filter(Boolean);
const MAINNET_CHAIN_ID = parseInt(process.env.MAINNET_CHAIN_ID || '10144'); // TBA: 메인넷 Chain ID

// 네트워크에 따른 설정 선택
const isMainnet = NETWORK_MODE === 'MAINNET';
const MONAD_RPCS = isMainnet ? MONAD_MAINNET_RPCS : MONAD_TESTNET_RPCS;
const CHAIN_ID = isMainnet ? MAINNET_CHAIN_ID : TESTNET_CHAIN_ID;

const SENDER_PRIVATE_KEY = process.env.PRIVATE_KEY || 'YOUR_PRIVATE_KEY_HERE';
// Gate 거래소 주소 또는 직접 설정한 수신 주소
const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS || process.env.GATE_EXCHANGE_ADDRESS || '0x...';

const SEND_AMOUNT_MON = process.env.SEND_AMOUNT_MON || '1.0';
const MIN_BALANCE_MON = process.env.MIN_BALANCE_MON || '0.01';

const GAS_LIMIT = parseInt(process.env.GAS_LIMIT || '21000');
const GAS_PRICE_GWEI = parseFloat(process.env.GAS_PRICE_GWEI || '100');
const GAS_PRICE_MULTIPLIER = parseFloat(process.env.GAS_PRICE_MULTIPLIER || '1.5');
const MIN_GAS_PRICE_GWEI = parseFloat(process.env.MIN_GAS_PRICE_GWEI || '50');
const MAX_GAS_PRICE_GWEI = parseFloat(process.env.MAX_GAS_PRICE_GWEI || '0');
const GAS_PRICE_CACHE_DURATION_MS = parseInt(process.env.GAS_PRICE_CACHE_DURATION_MS || '5000');
const GAS_PRICE_TIMEOUT_MS = parseInt(process.env.GAS_PRICE_TIMEOUT_MS || '3000');

const MONITOR_DURATION_MINUTES = parseInt(process.env.MONITOR_DURATION_MINUTES || '30');
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '50');

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 15 * * *';

const web3Instances = MONAD_TESTNET_RPCS.map(rpc => new Web3(rpc));
const web3 = web3Instances[0];

let cachedNonce = null;
let cachedGasPrice = null;
let cachedGasPriceTime = 0;

function invalidateGasPriceCache() {
    cachedGasPrice = null;
    cachedGasPriceTime = 0;
}

let privateKey = SENDER_PRIVATE_KEY;
if (!privateKey.startsWith('0x')) {
    privateKey = '0x' + privateKey;
}

let senderAccount;
try {
    if (privateKey === '0xYOUR_PRIVATE_KEY_HERE' || privateKey === '0x0x...') {
        console.error('❌ 개인키를 설정해주세요!');
        console.error('   환경변수 PRIVATE_KEY를 설정하거나 코드에서 SENDER_PRIVATE_KEY를 변경하세요.');
        process.exit(1);
    }
    senderAccount = web3.eth.accounts.privateKeyToAccount(privateKey);
    web3.eth.accounts.wallet.add(senderAccount);
    console.log('✅ 지갑 연결 성공:', senderAccount.address);
} catch (error) {
    console.error('❌ 지갑 연결 실패:', error.message);
    console.error('   개인키 형식이 올바른지 확인하세요.');
    process.exit(1);
}

async function getBalance(address) {
    try {
        const balance = await web3.eth.getBalance(address);
        return web3.utils.fromWei(balance, 'ether');
    } catch (error) {
        console.error('잔액 조회 실패:', error.message);
        return '0';
    }
}

async function getGasPrice() {
    const now = Date.now();
    
    if (cachedGasPrice && (now - cachedGasPriceTime) < GAS_PRICE_CACHE_DURATION_MS) {
        return cachedGasPrice;
    }
    
    try {
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('가스 가격 조회 타임아웃')), GAS_PRICE_TIMEOUT_MS)
        );
        
        const networkGasPrice = await Promise.race([
            web3.eth.getGasPrice(),
            timeoutPromise
        ]);
        
        const networkGasPriceGwei = parseFloat(web3.utils.fromWei(networkGasPrice, 'gwei'));
        
        let finalGasPriceGwei = networkGasPriceGwei * GAS_PRICE_MULTIPLIER;
        
        if (finalGasPriceGwei < MIN_GAS_PRICE_GWEI) {
            finalGasPriceGwei = MIN_GAS_PRICE_GWEI;
        }
        if (MAX_GAS_PRICE_GWEI > 0 && finalGasPriceGwei > MAX_GAS_PRICE_GWEI) {
            console.log(`⚠️  계산된 가스 가격(${finalGasPriceGwei.toFixed(2)} Gwei)이 최대 제한(${MAX_GAS_PRICE_GWEI} Gwei)을 초과합니다. 최대값 사용.`);
            finalGasPriceGwei = MAX_GAS_PRICE_GWEI;
        }
        
        cachedGasPrice = web3.utils.toWei(finalGasPriceGwei.toString(), 'gwei');
        cachedGasPriceTime = now;
        
        console.log(`⛽ 네트워크 가스 가격: ${networkGasPriceGwei.toFixed(2)} Gwei`);
        console.log(`⛽ 적용 가스 가격 (${GAS_PRICE_MULTIPLIER}x): ${finalGasPriceGwei.toFixed(2)} Gwei`);
        
        return cachedGasPrice;
    } catch (error) {
        console.error('⚠️  가스 가격 조회 실패, 캐시된 값 또는 기본값 사용:', error.message);
        
        if (cachedGasPrice) {
            console.log(`⛽ 캐시된 가스 가격 사용: ${web3.utils.fromWei(cachedGasPrice, 'gwei')} Gwei`);
            return cachedGasPrice;
        }
        
        const fallbackGasPrice = web3.utils.toWei(GAS_PRICE_GWEI.toString(), 'gwei');
        console.log(`⛽ 기본 가스 가격 사용: ${GAS_PRICE_GWEI} Gwei`);
        return fallbackGasPrice;
    }
}

async function sendRawTransactionParallel(rawTransaction) {
    // 모든 RPC에 동시에 브로드캐스트하고 가장 빠른 성공 응답만 사용 (Promise.race 사용!)
    console.log(`📡 ${web3Instances.length}개 RPC에 동시 브로드캐스트 중...`);
    
    // 모든 RPC에 동시에 전송 시작
    const promises = web3Instances.map((web3Instance, index) => {
        return new Promise((resolve, reject) => {
            const sendPromise = web3Instance.eth.sendSignedTransaction(rawTransaction);
            
            sendPromise
                .on('transactionHash', (hash) => {
                    // 성공하면 즉시 resolve (가장 빠른 응답!)
                    resolve({ success: true, hash, index });
                })
                .on('error', (error) => {
                    // 실패는 reject하지 않고 계속 기다림 (다른 RPC가 성공할 수 있음)
                    // 하지만 Promise.race를 위해 resolve하되 실패로 표시
                    resolve({ success: false, error: error.message, index });
                });
        });
    });
    
    // 가장 빠른 응답만 기다림 (Promise.race 사용 - 첫 번째 완료된 것만 받음)
    const firstResult = await Promise.race(promises);
    
    if (firstResult.success) {
        console.log(`✅ RPC #${firstResult.index + 1} 전송 성공 (가장 빠름): ${MONAD_TESTNET_RPCS[firstResult.index]}`);
        console.log(`   트랜잭션 해시: ${firstResult.hash}`);
        return { transactionHash: firstResult.hash };
    }
    
    // 첫 번째 응답이 실패면, 나머지 결과도 확인
    const allResults = await Promise.all(promises);
    const successResult = allResults.find(r => r.success);
    
    if (successResult) {
        console.log(`✅ RPC #${successResult.index + 1} 전송 성공: ${MONAD_TESTNET_RPCS[successResult.index]}`);
        console.log(`   트랜잭션 해시: ${successResult.hash}`);
        return { transactionHash: successResult.hash };
    }
    
    // 모든 RPC가 실패한 경우
    throw new Error(`모든 RPC 브로드캐스트 실패: ${firstResult.error || '알 수 없는 오류'}`);
}

async function getNonce() {
    if (cachedNonce === null) {
        try {
            cachedNonce = await web3.eth.getTransactionCount(senderAccount.address, 'pending');
            console.log(`📝 Nonce 초기화: ${cachedNonce}`);
        } catch (error) {
            console.error('Nonce 조회 실패:', error.message);
            cachedNonce = 0;
        }
    }
    return cachedNonce;
}

function incrementNonce() {
    if (cachedNonce !== null) {
        cachedNonce++;
    }
}

async function refreshNonce() {
    try {
        cachedNonce = await web3.eth.getTransactionCount(senderAccount.address, 'pending');
        console.log(`📝 Nonce 동기화: ${cachedNonce}`);
    } catch (error) {
        console.error('Nonce 동기화 실패:', error.message);
    }
}

async function sendMonTokens() {
    try {
        console.log('\n🔄 송금 프로세스 시작...');
        
        // 잔액 확인 (모니터링에서 이미 체크했지만, 정확한 계산을 위해 다시 조회)
        const balance = await getBalance(senderAccount.address);
        console.log(`💰 현재 잔액: ${balance} MON`);
        
        const balanceWei = web3.utils.toWei(balance, 'ether');
        const sendAmountWei = web3.utils.toWei(SEND_AMOUNT_MON, 'ether');
        const minBalanceWei = web3.utils.toWei(MIN_BALANCE_MON, 'ether');
        
        const balanceWeiBigInt = BigInt(balanceWei);
        const minBalanceWeiBigInt = BigInt(minBalanceWei);
        
        // 잔액 부족 확인
        if (balanceWeiBigInt < BigInt(sendAmountWei) + minBalanceWeiBigInt) {
            console.log('⚠️  잔액이 부족합니다. 송금을 건너뜁니다.');
            console.log(`   필요 잔액: ${parseFloat(SEND_AMOUNT_MON) + parseFloat(MIN_BALANCE_MON)} MON`);
            return;
        }
        
        const nonce = await getNonce();
        console.log(`📝 Nonce: ${nonce}`);
        
        const actualChainId = CHAIN_ID;
        
        const gasLimit = BigInt(GAS_LIMIT);
        const gasPrice = await getGasPrice();
        
        console.log(`⛽ 가스 설정:`);
        console.log(`   Gas Limit: ${gasLimit}`);
        console.log(`   Gas Price: ${web3.utils.fromWei(gasPrice, 'gwei')} Gwei`);
        
        const estimatedGasCost = BigInt(gasPrice) * gasLimit;
        console.log(`⛽ 예상 가스비: ${web3.utils.fromWei(estimatedGasCost.toString(), 'ether')} MON`);
        
        const transferAmount = balanceWeiBigInt - estimatedGasCost - minBalanceWeiBigInt;
        
        if (transferAmount <= 0) {
            console.log('⚠️  가스비를 제외한 전송 가능 금액이 없습니다.');
            return;
        }
        
        const tx = {
            chainId: actualChainId,
            from: senderAccount.address,
            to: RECIPIENT_ADDRESS,
            value: transferAmount.toString(),
            gas: gasLimit.toString(),
            gasPrice: gasPrice.toString(),
            nonce: nonce,
        };
        
        console.log(`🔗 사용할 체인 ID: ${actualChainId}`);
        
        console.log(`📤 송금 정보:`);
        console.log(`   From: ${tx.from}`);
        console.log(`   To: ${tx.to}`);
        console.log(`   Amount: ${web3.utils.fromWei(transferAmount.toString(), 'ether')} MON`);
        console.log(`   Gas Limit: ${gasLimit}`);
        console.log(`   Gas Price: ${web3.utils.fromWei(gasPrice, 'gwei')} Gwei`);
        console.log(`   예상 가스비: ${web3.utils.fromWei(estimatedGasCost.toString(), 'ether')} MON`);
        
        const signedTx = await web3.eth.accounts.signTransaction(tx, privateKey);
        console.log('✅ 트랜잭션 서명 완료');
        
        const result = await sendRawTransactionParallel(signedTx.rawTransaction);
        console.log('✅ 트랜잭션 전송 성공!');
        console.log(`   Transaction Hash: ${result.transactionHash}`);
        console.log(`   ⚡ Receipt를 기다리지 않고 즉시 반환 (빠름!)`);
        
        incrementNonce();
        console.log(`📝 Nonce 증가: ${cachedNonce}`);
        
        const sentAmount = web3.utils.fromWei(transferAmount.toString(), 'ether');
        console.log(`\n💸 ${sentAmount} MON 전송 요청 완료! (트랜잭션 해시: ${result.transactionHash})`);
        
    } catch (error) {
        console.error('❌ 송금 실패:', error.message);
        console.error('   전체 에러:', error);
        
        // Nonce 관련 오류 처리
        if (error.message && (error.message.includes('nonce') || error.message.includes('replacement') || error.message.includes('higher priority'))) {
            console.log('⚠️  Nonce 오류 감지, 네트워크에서 다시 조회합니다...');
            await refreshNonce();
            // Nonce 충돌 시 잠시 대기 후 재시도하지 않음 (다음 체크에서 자동으로 재시도됨)
        }
        
        // 가스비 관련 오류 처리
        if (error.message && (error.message.includes('fee too low') || error.message.includes('gas price') || error.message.includes('insufficient funds'))) {
            console.log('⚠️  가스비 관련 오류 감지, 가스비 캐시를 무효화하고 다시 조회합니다...');
            invalidateGasPriceCache();
        }
        
        if (error.receipt) {
            console.error('   Receipt:', error.receipt);
        }
        if (error.stack) {
            console.error('   Stack:', error.stack);
        }
        
        // 에러를 다시 던지지 않음 (다음 체크에서 자동으로 재시도됨)
    }
}

function scheduleOneTime(targetDate) {
    const now = new Date();
    const delay = targetDate.getTime() - now.getTime();
    
    if (delay <= 0) {
        console.log('⚠️  지정된 시간이 이미 지났습니다.');
        return;
    }
    
    const hours = Math.floor(delay / (1000 * 60 * 60));
    const minutes = Math.floor((delay % (1000 * 60 * 60)) / (1000 * 60));
    
    console.log(`⏰ ${targetDate.toLocaleString()}에 송금 예정`);
    console.log(`   남은 시간: ${hours}시간 ${minutes}분`);
    
    setTimeout(async () => {
        console.log('\n⏰ 예약된 시간 도달! 송금 시작...');
        await sendMonTokens();
        console.log('\n✅ 예약 송금 완료. 프로그램을 종료합니다.');
        process.exit(0);
    }, delay);
}

function scheduleRecurring(cronExpression) {
    console.log(`⏰ Cron 스케줄 설정: ${cronExpression}`);
    console.log('   다음 실행 시간을 확인하려면 Cron 표현식을 확인하세요.');
    
    cron.schedule(cronExpression, async () => {
        console.log('\n⏰ 스케줄된 시간 도달! 송금 시작...');
        await sendMonTokens();
    });
    
    console.log('✅ 스케줄러가 실행 중입니다. 종료하려면 Ctrl+C를 누르세요.');
}

async function monitorBalance(durationMinutes, intervalMs) {
    const startTime = Date.now();
    const endTime = startTime + (durationMinutes * 60 * 1000);
    let lastBalance = await getBalance(senderAccount.address);
    const minBalanceWei = web3.utils.toWei(MIN_BALANCE_MON, 'ether');
    let checkCount = 0;
    let isProcessing = false;
    
    console.log(`\n🔍 잔액 모니터링 시작`);
    console.log(`   모니터링 시간: ${durationMinutes}분`);
    console.log(`   체크 간격: ${intervalMs}ms (${intervalMs / 1000}초)`);
    console.log(`   초기 잔액: ${lastBalance} MON`);
    console.log(`   종료 시간: ${new Date(endTime).toLocaleTimeString()}\n`);
    
    const checkBalance = async () => {
        const now = Date.now();
        
        // 시간 초과 확인
        if (now >= endTime) {
            console.log(`\n⏰ 모니터링 시간 종료 (${durationMinutes}분 경과)`);
            console.log(`   총 체크 횟수: ${checkCount}회`);
            console.log(`   최종 잔액: ${lastBalance} MON`);
            console.log('👋 프로그램을 종료합니다.');
            process.exit(0);
        }
        
        // 전송 중이면 건너뛰기 (가장 먼저 체크)
        if (isProcessing) {
            return;
        }
        
        try {
            checkCount++;
            const currentBalance = await getBalance(senderAccount.address);
            const currentBalanceWei = web3.utils.toWei(currentBalance, 'ether');
            const lastBalanceWei = web3.utils.toWei(lastBalance, 'ether');
            
            const balanceDifference = Number(currentBalanceWei) - Number(lastBalanceWei);
            
            // 잔액이 충분한지 확인 (이전 잔액과 다를 때만 송금)
            if (Number(currentBalanceWei) > Number(minBalanceWei)) {
                // 잔액이 실제로 증가했는지 확인 (동일 잔액 중복 송금 방지)
                const hasBalanceIncreased = Number(currentBalanceWei) > Number(lastBalanceWei);
                
                if (hasBalanceIncreased || Number(lastBalanceWei) <= Number(minBalanceWei)) {
                    // isProcessing을 즉시 설정하여 동시 호출 방지
                    isProcessing = true;
                    
                    try {
                        const remainingTime = Math.floor((endTime - now) / 1000);
                        console.log(`\n🚨 잔액 감지! (체크 #${checkCount})`);
                        console.log(`   이전 잔액: ${lastBalance} MON`);
                        console.log(`   현재 잔액: ${currentBalance} MON`);
                        if (balanceDifference > 0) {
                            console.log(`   증가량: ${web3.utils.fromWei(balanceDifference.toString(), 'ether')} MON`);
                        }
                        console.log(`   남은 모니터링 시간: ${Math.floor(remainingTime / 60)}분 ${remainingTime % 60}초`);
                        
                        // 송금 실행
                        const balanceBeforeSend = await getBalance(senderAccount.address);
                        await sendMonTokens();
                        const balanceAfterSend = await getBalance(senderAccount.address);
                        
                        // 잔액 업데이트
                        lastBalance = balanceAfterSend;
                    } catch (sendError) {
                        // 송금 중 에러 발생 시 로그만 출력 (플래그는 finally에서 해제됨)
                        console.error(`⚠️  송금 중 에러 발생: ${sendError.message}`);
                        // 에러 발생 시에도 현재 잔액으로 업데이트
                        lastBalance = currentBalance;
                    } finally {
                        // 에러가 발생해도 항상 플래그 해제
                        isProcessing = false;
                    }
                }
            }
            
            if (checkCount % 10 === 0) {
                const remainingTime = Math.floor((endTime - now) / 1000);
                console.log(`[${new Date().toLocaleTimeString()}] 체크 #${checkCount} | 잔액: ${currentBalance} MON | 남은 시간: ${Math.floor(remainingTime / 60)}분 ${remainingTime % 60}초`);
            }
            
            lastBalance = currentBalance;
        } catch (error) {
            console.error(`❌ 잔액 체크 중 오류 (체크 #${checkCount}):`, error.message);
        }
    };
    
    await checkBalance();
    
    const intervalId = setInterval(checkBalance, intervalMs);
    
    setTimeout(() => {
        clearInterval(intervalId);
    }, durationMinutes * 60 * 1000);
}

async function main() {
    const networkName = isMainnet ? '메인넷' : '테스트넷';
    console.log(`🚀 Monad ${networkName} 자동 송금 봇 시작`);
    console.log('=====================================');
    console.log(`🌐 네트워크 모드: ${NETWORK_MODE}`);
    console.log(`📡 RPC: ${MONAD_RPCS[0] || 'N/A'}`);
    console.log(`🔗 Chain ID: ${CHAIN_ID}`);
    console.log(`👤 송금 지갑: ${senderAccount.address}`);
    console.log(`📬 수신 지갑: ${RECIPIENT_ADDRESS}`);
    if (process.env.GATE_EXCHANGE_ADDRESS) {
        console.log(`🏦 Gate 거래소 주소 사용 중`);
    }
    console.log(`💰 송금 금액: 전체 잔액 (최소 ${MIN_BALANCE_MON} MON 유지)`);
    console.log('=====================================\n');
    
    await refreshNonce();
    
    const initialBalance = await getBalance(senderAccount.address);
    console.log(`💰 초기 잔액: ${initialBalance} MON\n`);
    
    // 초기 잔액이 있으면 즉시 전송
    const initialBalanceWei = web3.utils.toWei(initialBalance, 'ether');
    const minBalanceWei = web3.utils.toWei(MIN_BALANCE_MON, 'ether');
    
    if (Number(initialBalanceWei) > Number(minBalanceWei)) {
        console.log('✅ 초기 잔액 감지! 즉시 송금을 시작합니다...\n');
        await sendMonTokens();
        console.log('\n✅ 초기 잔액 전송 완료. 이제 모니터링을 시작합니다...\n');
    }
    
    await monitorBalance(MONITOR_DURATION_MINUTES, POLLING_INTERVAL_MS);
}

main().catch(console.error);

process.on('unhandledRejection', (error) => {
    console.error('❌ 처리되지 않은 에러:', error);
});

process.on('SIGINT', () => {
    console.log('\n\n👋 프로그램을 종료합니다.');
    process.exit(0);
});

