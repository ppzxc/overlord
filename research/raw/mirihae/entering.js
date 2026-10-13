const urlParams = new URLSearchParams(window.location.search);
const redirectUrl = urlParams.get(uriParameterName);
const redirectUri = redirectUrl.split('?')[0];
const encodedUri = encodeURIComponent(redirectUri);

document.addEventListener('DOMContentLoaded', () => {
    sendFetchRequest();
});

function setCookie(name, value, hours) {
    let expires = "";
    if (hours) {
        let date = new Date();
        date.setTime(date.getTime() + (hours * 24 * 60 * 60 * 1000));
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

function generateRandomKey(length) {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

function sendFetchRequest() {
    const token = getCookie(enteringTokenName);
    const url = `${domain}/api/entering?${uriParameterName}=${encodedUri}`;

    const headers = new Headers({});
    headers.append('Content-Type', 'application/json');
    if (token) {
        headers.append(enteringTokenName, token);
    }

    fetch(url, {
        method: 'GET',
        headers: headers
    })
        .then(response => {
            if (response.status == 200) {
                return response.json();
            }
            if (response.status == 401) {
                window.location.href = `${waitingPageUri}`
                    + `?${uriParameterName}=${encodeURIComponent(redirectUrl)}`;

            }
            else if (response.status == 403) {
                window.location.href = `${prewaitingPageUri}`
                    + `?${uriParameterName}=${encodeURIComponent(redirectUrl)}`;

            }
            else if (response.status == 404) {
                window.location.href = `${notfoundPageUri}`
                    + `?${uriParameterName}=${encodeURIComponent(redirectUrl)}`;
            }
            else {
                let clientRedirectUrl = new URL(redirectUrl);
                clientRedirectUrl.searchParams.append(gateTokenParameterName, uuid.v4());
                window.location.href = clientRedirectUrl.toString();
            }
        })
        .then(responseBody => {
            let clientRedirectUrl = new URL(redirectUrl);
            clientRedirectUrl.searchParams.append(gateTokenParameterName, responseBody.enteringToken);
            window.location.href = clientRedirectUrl.toString();
        })
        .catch(error => {
            console.log(error);
        });
}