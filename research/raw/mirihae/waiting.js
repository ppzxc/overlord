const urlParams = new URLSearchParams(window.location.search);
const redirectUrl = urlParams.get(uriParameterName);
const redirectUri = redirectUrl.split('?')[0];
const encodedUri = encodeURIComponent(redirectUri);

document.addEventListener('DOMContentLoaded', () => {
    handleGoogleTracking();
    handleWaitingToken();
});

function setCookie(name, value, hour) {
    let expires = "";
    if (hour) {
        let date = new Date();
        date.setTime(date.getTime() + (hour * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    let cookie = encodeURIComponent(name) + "=" + encodeURIComponent(value) + expires + "; path=/";
    document.cookie = cookie;
    console.log("Setting cookie: " + cookie);
    console.log("Cookie set: " + document.cookie);
}

function getCookie(name) {
    let nameEQ = encodeURIComponent(name) + "=";
    let ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length));
    }
    return null;
}

async function handleGoogleTracking() {

    //google tracking id 조회
    const groupUri = `${domain}/api/groups?${uriParameterName}=${encodedUri}`;
    let response = await fetch(groupUri);
    if (response.status == 200) {
        const groups = await response.json();
        let trackingId = groups[0].googleTrackingId;
        let gtagScript = document.createElement('script');
        gtagScript.async = true;
        gtagScript.src = 'https://www.googletagmanager.com/gtag/js?id=' + trackingId;

        // script 요소를 head에 추가
        document.head.appendChild(gtagScript);

        // gtag 설정 코드
        window.dataLayer = window.dataLayer || [];
        function gtag() { dataLayer.push(arguments); }
        gtag('js', new Date());

        gtag('config', trackingId);
    }
}


async function handleWaitingToken() {
    const waitingUrl = `${domain}/api/waiting?${uriParameterName}=${encodedUri}`;

    let waitingToken = sessionStorage.getItem(waitingTokenName);

    // 대기 순번 확인 요청
    async function sendPeriodicRequest() {
        try {
            let response = await fetch(waitingUrl, {
                headers: {
                    'X-Mirihae-Waiting-Token': waitingToken,
                }
            });

            // 접근할 수 없는 경우
            if (response.status === 403) {
                window.location.href = `${prewaitingPageUri}`
                    + `?${uriParameterName}=${encodeURIComponent(redirectUrl)}`;
            }
            // 아직 대기 중인 경우
            if (response.status === 425) {
                // waiting.html의 페이지에 현재 순번을 보여주는 로직
                let errorResponse = await response.json();
                let waitingOrder = JSON.parse(errorResponse.message);

                // 서버가 계산해 준 값을 그대로 쓴다. 없으면(구버전 서버) 기존 식으로 되돌아간다.
                // throughput 은 초당 환산값이라 구버전 식으로 계산해도 결과가 맞다.
                let waitingTime = waitingOrder.estimatedWaitSeconds
                    ?? Math.ceil(waitingOrder.order / waitingOrder.throughput);

                // 만료된 대기 토큰을 서버가 같은 순서로 재발급해 준 경우 교체한다.
                // 교체하지 않으면 다음 요청에서 새 토큰을 받아 대기열 맨 뒤로 밀린다.
                const refreshedToken = response.headers.get('X-Mirihae-Waiting-Token');
                if (refreshedToken) {
                    waitingToken = refreshedToken;
                    sessionStorage.setItem(waitingTokenName, refreshedToken);
                }

                if (waitingTime < 10) {
                    clearInterval(schedulingId);
                    // estimatedWaitSeconds 는 서버가 이미 최소 1초를 보장한다. 이 바닥값은
                    // 그 값을 다시 늦추려는 게 아니라, 구버전 서버 호환용 폴백 식(order/throughput)이
                    // order=0 일 때 0을 뱉던 예전 장애 경로를 막기 위한 순수 안전망이다.
                    const safeWaitingTime = Math.max(waitingTime, 1);
                    setTimeout(sendPeriodicRequest, safeWaitingTime * 1000);
                }
                let waitingTimeSec = waitingTime % 60;
                let waitingTimeMin = Math.floor(waitingTime / 60) % 60;
                let waitingTimeHour = Math.floor(Math.floor(waitingTime / 60) / 60);
                let waitingTimeString = "";
                if (waitingTimeHour != 0) {
                    waitingTimeString += waitingTimeHour + "시간 ";
                }
                if (waitingTimeMin != 0) {
                    waitingTimeString += waitingTimeMin + "분 ";
                }
                waitingTimeString += waitingTimeSec + "초";

                document.getElementById('ordering').innerText = waitingOrder.order;
                document.getElementById('waiting-time').innerText = '대기 예상 시간 : ' + waitingTimeString;
            }
            // 자신의 순서가 된 경우
            else if (response.status === 200) {
                sessionStorage.removeItem(waitingTokenName);

                let responseBody = await response.json();
                setCookie(enteringTokenName, responseBody.enteringToken, 1);

                window.location.href = `${enteringPageUri}`
                    + `?${uriParameterName}=${encodeURIComponent(redirectUrl)}`;
            }
            // 예상치 못한 예외 상황
            else {
                sessionStorage.removeItem(waitingTokenName);

                console.error('Unexpected response status:', response.status);
                location.reload();
            }
        } catch (error) {
            console.error('Request failed:', error);
        }
    }

    // 대기 토큰이 존재하는 경우
    let schedulingId;
    if (waitingToken) {
        schedulingId = setInterval(sendPeriodicRequest, 10000);
        sendPeriodicRequest();
    }
    // 대기 토큰이 없는 경우 생성 요청
    else {
        try {
            let response = await fetch(waitingUrl, {
                method: 'POST',
            });
            // 대기 토큰 발급 성공시
            if (response.ok) {
                let waitingToken = await response.text();
                sessionStorage.setItem(waitingTokenName, waitingToken);
                location.reload();
            }
            // 대기 토큰 발급 시점이 아닌 경우 ( 예약 시점 1시간 이전부터 접근 막는 경우 )
            else if (response.status === 403) {
                window.location.href = `${prewaitingPageUri}`
                    + `?${uriParameterName}=${encodeURIComponent(redirectUrl)}`;
            }
        } catch (error) {
            console.error('Request failed:', error);
        }
    }
}

function countdown() {
    const timeElement = document.getElementById('waiting-time');
    let timeText = timeElement.textContent;

    // '대기 예상 시간 :' 부분을 제거하고 'XX시 XX분 XX초'만 남김
    let timeParts = timeText.replace('대기 예상 시간 :', '').trim().split(' ');

    let hours = 0, minutes = 0, seconds = 0;

    timeParts.forEach(part => {
        if (part.includes('시간')) {
            hours = parseInt(part.replace('시간', ''));
        } else if (part.includes('분')) {
            minutes = parseInt(part.replace('분', ''));
        } else if (part.includes('초')) {
            seconds = parseInt(part.replace('초', ''));
        }
    });

    // 시간을 1초씩 줄임
    if (seconds > 0) {
        seconds--;
    } else if (minutes > 0) {
        minutes--;
        seconds = 59;
    } else if (hours > 0) {
        hours--;
        minutes = 59;
        seconds = 59;
    } else {
        clearInterval(timer);
        return; // 시간이 모두 줄어들면 종료
    }

    // 업데이트된 시간을 다시 포맷
    let newTimeText = '대기 예상 시간 :';
    if (hours > 0) {
        newTimeText += ` ${hours}시간`;
    }
    if (minutes > 0 || hours > 0) {
        newTimeText += ` ${minutes}분`;
    }
    newTimeText += ` ${seconds}초`;

    timeElement.textContent = newTimeText.trim();
}

// 1초마다 countdown 함수 실행
const timer = setInterval(countdown, 1000);