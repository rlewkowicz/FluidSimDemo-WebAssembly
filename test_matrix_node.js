// Assume add.wasm file exists that contains a single function adding 2 provided arguments
const fs = require('fs');

const wasmBuffer = fs.readFileSync('test_matrix.wasm');
WebAssembly.instantiate(wasmBuffer).then(wasmModule => {
  // Exported function live under instance.exports
  const { julia_sum_matrix, memory } = wasmModule.instance.exports;

    // wasm64: 4 BigInt64 metadata fields (pointer, length, sz1, sz2)
    const array = new BigInt64Array(memory.buffer, 0, 4)

    // data starts after 4 i64
    const offset = 4n*8n
    array.set([offset, 6n, 2n, 3n])

    const arrayf = new Float32Array(memory.buffer, Number(offset), 6)
    arrayf.set([2, 3, 4, 5, 6, 7.01])

    // Call the function and display the results.
    const result = julia_sum_matrix(BigInt(array.byteOffset))

    console.log(result);

    console.log(arrayf);

});
