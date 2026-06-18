import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
    vus: 100,
    duration: '60s',
    ext: {
        loadimpact: {
            projectID: 3648966,
            name: 'L2 and BatchL2 tests'
        }
    }
};

const l2Url = 'https://mainnet-beta.api.drift.trade/dlob/l2?marketIndex=0&marketType=perp&depth=20&grouping=100&includeVamm=true&includePhoenix=false&includeSerum=false';
const batchL2Url = 'https://mainnet-beta.api.drift.trade/dlob/batchL2?marketType=perp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cspot%2Cspot%2Cspot&marketIndex=0%2C1%2C2%2C3%2C4%2C5%2C6%2C7%2C8%2C9%2C10%2C11%2C12%2C0%2C1%2C2&depth=100%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5&includeVamm=true%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Cfalse%2Cfalse%2Cfalse&includePhoenix=false%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Ctrue%2Ctrue%2Ctrue&includeSerum=false%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Ctrue%2Ctrue%2Ctrue';
// const l2Url = 'http://localhost:6969/l2?marketIndex=0&marketType=perp&depth=20&grouping=100&includeVamm=true&includePhoenix=false&includeSerum=false';
// const batchL2Url = 'http://localhost:6969/batchL2?marketType=perp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cperp%2Cspot%2Cspot%2Cspot&marketIndex=0%2C1%2C2%2C3%2C4%2C5%2C6%2C7%2C8%2C9%2C10%2C11%2C12%2C0%2C1%2C2&depth=100%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5%2C5&includeVamm=true%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Ctrue%2Cfalse%2Cfalse%2Cfalse&includePhoenix=false%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Ctrue%2Ctrue%2Ctrue&includeSerum=false%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Cfalse%2Ctrue%2Ctrue%2Ctrue';

export default function() {
    for (let i = 0; i < 10; i += 1) {
        http.get(l2Url);
        if (i % 2 === 0) {
            http.get(batchL2Url);
        }
        sleep(1);
    }
}