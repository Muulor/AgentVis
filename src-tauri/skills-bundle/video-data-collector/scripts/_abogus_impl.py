# path: f2/utils/abogus.py

#!/usr/bin/env python
# -*- encoding: utf-8 -*-
"""
@Description:abogus.py
@Date       :2024/06/16 11:21:14
@Author     :JohnserfSeed
@version    :0.0.3
@License    :Apache License 2.0
@Github     :https://github.com/johnserf-seed
@Mail       :support@f2.wiki
-------------------------------------------------
Change Log  :
2024/06/16 17:27:47 - Create ABogus algorithm & black style
2024/06/16 17:27:47 - Limit custom ua late open source full version
2024/07/08 21:50:12 - Open the full version of the custom UA
2025/03/05 155:55:42 - Perf Post Method Generate
-------------------------------------------------
"""

import time
import random

from gmssl import sm3, func
from typing import Union, Callable, List, Dict


class StringProcessor:
    """
    The StringProcessor class provides string-processing methods required by
    the ABogus algorithm, including conversion between strings and ASCII codes,
    unsigned right shifts, and related operations.

    Class methods:

        to_ord_str(s: str) -> str:
            Convert a string to an ASCII code string.

        to_ord_array(s: str) -> List[int]:
            Convert a string to a list of ASCII codes.

        to_char_str(s: str) -> str:
            Convert a list of ASCII codes to a string.

        to_char_array(s: str) -> List[int]:
            Convert a string to a list of ASCII codes.

        js_shift_right(val: int, n: int) -> int:
            Implement the unsigned right shift operation in JavaScript.

        generate_random_bytes(length: int = 3) -> str:
            Generate a pseudo-random byte string used to obfuscate data.

    Usage example:
    ```python
        # Convert a string to an ASCII code string.
        ord_str = StringProcessor.to_ord_str("Hello, World!")
        print(ord_str)

        # Convert a string to a list of ASCII codes.
        ord_array = StringProcessor.to_ord_array("Hello, World!")
        print(ord_array)

        # Convert a list of ASCII codes to a string.
        char_str = StringProcessor.to_char_str(ord_array)
        print(char_str)

        # Convert a string to a list of ASCII codes.
        char_array = StringProcessor.to_char_array("Hello, World!")
        print(char_array)

        # Implement JavaScript's unsigned right shift operation.
        shifted_val = StringProcessor.js_shift_right(10, 2)
        print(shifted_val)

        # Generate a pseudo-random byte string.
        random_bytes = StringProcessor.generate_random_bytes(3)
        print(random_bytes)
    ```
    """

    @staticmethod
    def to_ord_str(s: str) -> str:
        """
        Convert a string to an ASCII code string.

        Args:
            s (str): Input string.

        Returns:
            str: Converted ASCII code string.
        """
        return "".join([chr(i) for i in s])

    @staticmethod
    def to_ord_array(s: str) -> List[int]:
        """
        Convert a string to a list of ASCII codes.

        Args:
            s (str): Input string.

        Returns:
            List[int]: Converted list of ASCII codes.
        """
        return [ord(char) for char in s]

    @staticmethod
    def to_char_str(s: str) -> str:
        """
        Convert a list of ASCII codes to a string.

        Args:
            s (str): List of ASCII codes.

        Returns:
            str: Converted string.
        """
        return "".join([chr(i) for i in s])

    @staticmethod
    def to_char_array(s: str) -> List[int]:
        """
        Convert a string to a list of ASCII codes.

        Args:
            s (str): Input string.

        Returns:
            List[int]: Converted list of ASCII codes.
        """
        return [ord(char) for char in s]

    @staticmethod
    def js_shift_right(val: int, n: int) -> int:
        """
        Implement the unsigned right shift operation in JavaScript.

        Args:
            val (int): Input value.
            n (int): Number of bits to shift right.

        Returns:
            int: Value after right shift.
        """
        return (val % 0x100000000) >> n

    @staticmethod
    def generate_random_bytes(length: int = 3) -> str:
        """
        Generate a pseudo-random byte string to obfuscate the data.

        Args:
            length (int): Length of the byte sequence to generate.

        Returns:
            str: Generated pseudo-random byte string.
        """

        def generate_byte_sequence() -> List[str]:
            _rd = int(random.random() * 10000)
            return [
                chr(((_rd & 255) & 170) | 1),
                chr(((_rd & 255) & 85) | 2),
                chr((StringProcessor.js_shift_right(_rd, 8) & 170) | 5),
                chr((StringProcessor.js_shift_right(_rd, 8) & 85) | 40),
            ]

        result = []
        for _ in range(length):
            result.extend(generate_byte_sequence())

        return "".join(result)


class CryptoUtility:
    """
    The CryptoUtility class provides encryption and encoding utility methods,
    including SM3 hashing, adding salt, Base64 encoding, RC4 encryption, and
    related operations.

    Class attributes:
        salt (str): Encryption salt.
        base64_alphabet (List[str]): Custom Base64 alphabet.

    Class methods:
        sm3_to_array(input_data: Union[str, List[int]]) -> List[int]:
            Calculate the SM3 hash value of the request body and convert the
            result to an array of integers.

        add_salt(param: str) -> str:
            Add salt to the string parameter.

        process_param(param: Union[str, List[int]], add_salt: bool) -> Union[str, List[int]]:
            Process input parameter and add salt if needed.

        params_to_array(param: Union[str, List[int]], add_salt: bool = True) -> List[int]:
            Get the hash array of the input parameter.

        transform_bytes(bytes_list: List[int]) -> str:
            Encrypt/decrypt the input byte list and return the processed string.

        base64_encode(input_string: str, selected_alphabet: int = 0) -> str:
            Encode the input string using a custom Base64 alphabet.

        abogus_encode(abogus_bytes_str: str, selected_alphabet: int) -> str:
            Encode the input byte string using a custom Base64 alphabet, and add
            shifts and padding.

        rc4_encrypt(key: bytes, plaintext: str) -> bytes:
            Encrypt data using the RC4 algorithm.

    Usage example:
    ```python
        # Calculate the SM3 hash value of the request body.
        sm3_hash = CryptoUtility.sm3_to_array("Hello, World!")
        print(sm3_hash)

        # Add salt to the string parameter.
        salted_param = CryptoUtility.add_salt("Hello, World!")
        print(salted_param)

        # Get the hash array of the input parameter.
        hash_array = CryptoUtility.params_to_array("Hello, World!")
        print(hash_array)

        # Encrypt/decrypt the input byte list.
        encrypted_str = CryptoUtility.transform_bytes([72, 101, 108, 108, 111, 44, 32, 87, 111, 114, 108, 100, 33])
        print(encrypted_str)

        # Encode the input string using a custom Base64 alphabet.
        base64_str = CryptoUtility.base64_encode("Hello, World!")
        print(base64_str)

        # Encode the input byte string using a custom Base64 alphabet, and add shifts and padding.
        abogus_str = CryptoUtility.abogus_encode("Hello, World!", 0)
        print(abogus_str)

        # Encrypt data using the RC4 algorithm.
        key = b"key"
        plaintext = "Hello, World!"
        ciphertext = CryptoUtility.rc4_encrypt(key, plaintext)
        print(ciphertext)
    ```
    """

    def __init__(self, salt: str, custom_base64_alphabet: List[str]):
        """
        Initialize the CryptoUtility class.

        Args:
            salt (str): Encryption salt.
            custom_base64_alphabet (List[str]): Custom Base64 alphabet.
        """
        self.salt = salt
        self.base64_alphabet = custom_base64_alphabet

        # fmt: off
        self.big_array = [
            121, 243,  55, 234, 103,  36,  47, 228,  30, 231, 106,   6, 115,  95,  78, 101, 250, 207, 198,  50,
            139, 227, 220, 105,  97, 143,  34,  28, 194, 215,  18, 100, 159, 160,  43,   8, 169, 217, 180, 120,
            247,  45,  90,  11,  27, 197,  46,   3,  84,  72,   5,  68,  62,  56, 221,  75, 144,  79,  73, 161,
            178,  81,  64, 187, 134, 117, 186, 118,  16, 241, 130,  71,  89, 147, 122, 129,  65,  40,  88, 150,
            110, 219, 199, 255, 181, 254,  48,   4, 195, 248, 208,  32, 116, 167,  69, 201,  17, 124, 125, 104,
             96,  83,  80, 127, 236, 108, 154, 126, 204,  15,  20, 135, 112, 158,  13,   1, 188, 164, 210, 237,
            222,  98, 212,  77, 253,  42, 170, 202,  26,  22,  29, 182, 251,  10, 173, 152,  58, 138,  54, 141,
            185,  33, 157,  31, 252, 132, 233, 235, 102, 196, 191, 223, 240, 148,  39, 123,  92,  82, 128, 109,
             57,  24,  38, 113, 209, 245,   2, 119, 153, 229, 189, 214, 230, 174, 232,  63,  52, 205,  86, 140,
             66, 175, 111, 171, 246, 133, 238, 193,  99,  60,  74,  91, 225,  51,  76,  37, 145, 211, 166, 151,
            213, 206,   0, 200, 244, 176, 218,  44, 184, 172,  49, 216,  93, 168,  53,  21, 183,  41,  67,  85,
            224, 155, 226, 242,  87, 177, 146,  70, 190,  12, 162,  19, 137, 114,  25, 165, 163, 192,  23,  59,
              9,  94, 179, 107,  35,   7, 142, 131, 239, 203, 149, 136,  61, 249,  14, 156
        ]
        # fmt: on

    @staticmethod
    def sm3_to_array(input_data: Union[str, List[int]]) -> List[int]:
        """
        Calculate the SM3 hash value of the request body and convert the result
        to an array of integers.

        Args:
            input_data (Union[str, List[int]]): Input data.

        Returns:
            List[int]: Array of integers representing the hash value.
        """
        # If the input is a string, encode it as a byte array.
        if isinstance(input_data, str):
            input_data_bytes = input_data.encode("utf-8")
        else:
            input_data_bytes = bytes(input_data)  # Convert List[int] to a byte array.

        # Convert the byte array to the list format suitable for sm3.sm3_hash.
        hex_result = sm3.sm3_hash(func.bytes_to_list(input_data_bytes))

        # Convert the hexadecimal string result to a list of decimal integers.
        return [int(hex_result[i : i + 2], 16) for i in range(0, len(hex_result), 2)]

    def add_salt(self, param: str) -> str:
        """
        Add salt to the string parameter.

        Args:
            param (str): Input string.

        Returns:
            str: String with added salt.
        """
        return param + self.salt

    def process_param(
        self, param: Union[str, List[int]], add_salt: bool
    ) -> Union[str, List[int]]:
        """
        Process input parameter and add salt if needed.

        Args:
            param (Union[str, List[int]]): Input parameter.
            add_salt (bool): Whether to add salt.

        Returns:
            Union[str, List[int]]: Processed parameter.
        """
        if isinstance(param, str) and add_salt:
            param = self.add_salt(param)
        return param

    def params_to_array(
        self, param: Union[str, List[int]], add_salt: bool = True
    ) -> List[int]:
        """
        Get the hash array of the input parameter.

        Args:
            param (Union[str, List[int]]): Input parameter.
            add_salt (bool): Whether to add salt.

        Returns:
            List[int]: Hash array.
        """
        processed_param = self.process_param(param, add_salt)
        return self.sm3_to_array(processed_param)

    def transform_bytes(self, bytes_list: List[int]) -> str:
        """
        Encrypt/decrypt the input byte list and return the processed string.

        Args:
            bytes_list (List[int]): Input byte list.

        Returns:
            str: Processed string.
        """
        # Convert the byte list to a character string.
        bytes_str = StringProcessor.to_char_str(bytes_list)
        result_str = []
        index_b = self.big_array[1]
        initial_value = 0

        for index, char in enumerate(bytes_str):
            if index == 0:
                initial_value = self.big_array[index_b]
                sum_initial = index_b + initial_value

                self.big_array[1] = initial_value
                self.big_array[index_b] = index_b
            else:
                sum_initial = initial_value + value_e

            char_value = ord(char)
            sum_initial %= len(self.big_array)
            value_f = self.big_array[sum_initial]
            encrypted_char = char_value ^ value_f
            result_str.append(chr(encrypted_char))

            # Swap array elements.
            value_e = self.big_array[(index + 2) % len(self.big_array)]
            sum_initial = (index_b + value_e) % len(self.big_array)
            initial_value = self.big_array[sum_initial]
            self.big_array[sum_initial] = self.big_array[
                (index + 2) % len(self.big_array)
            ]
            self.big_array[(index + 2) % len(self.big_array)] = initial_value
            index_b = sum_initial

        return "".join(result_str)

    def base64_encode(self, input_string: str, selected_alphabet: int = 0) -> str:
        """
        Encode the input string using a custom Base64 alphabet.

        Args:
            input_string (str): Input string.
            selected_alphabet (int): Selected custom Base64 alphabet index.

        Returns:
            str: Encoded string.
        """

        # Convert the input string to the binary form of ASCII codes.
        binary_string = "".join(["{:08b}".format(ord(char)) for char in input_string])

        # Pad the binary string so its length is a multiple of 6.
        padding_length = (6 - len(binary_string) % 6) % 6
        binary_string += "0" * padding_length

        # Split the binary string into 6-bit groups.
        base64_indices = [
            int(binary_string[i : i + 6], 2) for i in range(0, len(binary_string), 6)
        ]

        # Generate the output string according to the custom alphabet.
        output_string = "".join(
            [self.base64_alphabet[selected_alphabet][index] for index in base64_indices]
        )

        # Add equals-sign padding to comply with the Base64 encoding specification.
        output_string += "=" * (padding_length // 2)

        return output_string

    def abogus_encode(self, abogus_bytes_str: str, selected_alphabet: int) -> str:
        """
        Encode the input byte string using a custom Base64 alphabet, and add
        shifts and padding.

        Args:
            abogus_bytes_str (str): Input byte string.
            selected_alphabet (int): Selected custom Base64 alphabet index.

        Returns:
            str: Encoded string.
        """
        abogus = []

        for i in range(0, len(abogus_bytes_str), 3):
            if i + 2 < len(abogus_bytes_str):
                n = (
                    (ord(abogus_bytes_str[i]) << 16)
                    | (ord(abogus_bytes_str[i + 1]) << 8)
                    | ord(abogus_bytes_str[i + 2])
                )
            elif i + 1 < len(abogus_bytes_str):
                n = (ord(abogus_bytes_str[i]) << 16) | (
                    ord(abogus_bytes_str[i + 1]) << 8
                )
            else:
                n = ord(abogus_bytes_str[i]) << 16

            for j, k in zip(range(18, -1, -6), (0xFC0000, 0x03F000, 0x0FC0, 0x3F)):
                if j == 6 and i + 1 >= len(abogus_bytes_str):
                    break
                if j == 0 and i + 2 >= len(abogus_bytes_str):
                    break
                abogus.append(self.base64_alphabet[selected_alphabet][(n & k) >> j])

        abogus.append("=" * ((4 - len(abogus) % 4) % 4))
        return "".join(abogus)

    @staticmethod
    def rc4_encrypt(key: bytes, plaintext: str) -> bytes:
        """
        Encrypt data using the RC4 algorithm.

        Args:
            key (bytes): Encryption key.
            plaintext (str): Plaintext data.

        Returns:
            bytes: Encrypted data.
        """
        S = list(range(256))
        j = 0
        for i in range(256):
            j = (j + S[i] + key[i % len(key)]) % 256
            S[i], S[j] = S[j], S[i]

        i = j = 0
        ciphertext = []
        for char in plaintext:
            i = (i + 1) % 256
            j = (j + S[i]) % 256
            S[i], S[j] = S[j], S[i]
            K = S[(S[i] + S[j]) % 256]
            ciphertext.append(ord(char) ^ K)

        return bytes(ciphertext)


class BrowserFingerprintGenerator:
    """
    BrowserFingerprintGenerator generates simulated browser fingerprint
    information for testing and data collection in different browser
    environments.

    Class attributes:
        browsers (Dict[str, Callable[[], str]]): Mapping between browser types
            and browser fingerprint generators.

    Methods:
        generate_fingerprint(browser_type="Edge"):
            Generate a browser fingerprint based on the specified browser type.

        generate_chrome_fingerprint():
            Generate a Chrome browser fingerprint.

        generate_firefox_fingerprint():
            Generate a Firefox browser fingerprint.

        generate_safari_fingerprint():
            Generate a Safari browser fingerprint.

        generate_edge_fingerprint():
            Generate an Edge browser fingerprint.

        _generate_fingerprint(platform="Win32"):
            Generate a browser fingerprint string based on the given parameters.

    Usage example:
    ```python
        chrome_fp = BrowserFingerprintGenerator.generate_fingerprint("Chrome")
        print(chrome_fp)
    ```
    """

    @classmethod
    def generate_fingerprint(cls, browser_type: str = "Edge") -> str:
        """
        Generate a browser fingerprint based on the specified browser type.

        Args:
            browser_type (str): Browser type.

        Returns:
            str: Generated browser fingerprint string.
        """
        cls.browsers: Dict[str, Callable[[], str]] = {
            "Chrome": cls.generate_chrome_fingerprint,
            "Firefox": cls.generate_firefox_fingerprint,
            "Safari": cls.generate_safari_fingerprint,
            "Edge": cls.generate_edge_fingerprint,
        }
        return cls.browsers.get(browser_type, cls.generate_chrome_fingerprint)()

    @classmethod
    def generate_chrome_fingerprint(cls) -> str:
        return cls._generate_fingerprint(platform="Win32")

    @classmethod
    def generate_firefox_fingerprint(cls) -> str:
        return cls._generate_fingerprint(platform="Win32")

    @classmethod
    def generate_safari_fingerprint(cls) -> str:
        return cls._generate_fingerprint(platform="MacIntel")

    @classmethod
    def generate_edge_fingerprint(cls) -> str:
        return cls._generate_fingerprint(platform="Win32")

    @staticmethod
    def _generate_fingerprint(platform: str) -> str:
        """
        Generate a browser fingerprint string based on the given parameters.

        Args:
            platform (str): Operating system platform.

        Returns:
            str: Generated browser fingerprint string.
        """
        inner_width = random.randint(1024, 1920)
        inner_height = random.randint(768, 1080)
        outer_width = inner_width + random.randint(24, 32)
        outer_height = inner_height + random.randint(75, 90)
        screen_x = 0
        screen_y = random.choice([0, 30])
        size_width = random.randint(1024, 1920)
        size_height = random.randint(768, 1080)
        avail_width = random.randint(1280, 1920)
        avail_height = random.randint(800, 1080)

        fingerprint = (
            f"{inner_width}|{inner_height}|{outer_width}|{outer_height}|"
            f"{screen_x}|{screen_y}|0|0|{size_width}|{size_height}|"
            f"{avail_width}|{avail_height}|{inner_width}|{inner_height}|24|24|{platform}"
        )
        return fingerprint


class ABogus:
    """
    The ABogus class generates ABogus parameters.

    Class attributes:
        array1 (List[int]): Encrypted request body.
        array2 (List[int]): Encrypted request header.
        array3 (List[int]): Encrypted User-Agent.
        aid (int): AID value.
        pageId (int): Page ID.
        salt (str): Encryption salt.
        options (List[int]): Request options.
        ua_key (bytes): UA encryption key.
        character (str): Custom Base64 alphabet.
        character2 (str): Custom Base64 alphabet.
        character_list (List[str]): List of custom Base64 alphabets.
        crypto_utility (CryptoUtility): Encryption utility.
        user_agent (str): Custom User-Agent.
        browser_fp (str): Browser fingerprint.
        sort_index (List[int]): Sort index.
        sort_index_2 (List[int]): Sort index.

    Notes:
        The options parameter is used to specify the request type. GET requests
        use [0, 1, 8], and POST requests use [0, 1, 14]. 14 is compatible with
        8, and POST can also encode params, so it is hardcoded.

    Methods:
        encode_data(data: str, alphabet_index: int = 0) -> str:
            Encode the data using the specified Base64 alphabet.

        generate_abogus(params: str, request: str = "") -> str:
            Generate the ABogus parameter.

    Usage example:
    ```python
        # Generate ABogus parameters. Leave empty to use the default UA and browser fingerprint.
        abogus = ABogus(user_agent="xxx", fp="xxx")
        abogus_param = abogus.generate_abogus("device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=7380308675841297704...omitted...")
        print(abogus_param[1])
    ```
    """

    def __init__(
        self,
        fp: str = "",
        user_agent: str = "",
        options: List[int] = [0, 1, 14],
    ):
        self.aid = 6383
        self.pageId = 0  # 1.0.1.19 ->  6241
        self.salt = "cus"  # 1.0.1.19 -> encryption salt # dhzx
        self.boe = False
        self.ddrt = 8.5
        self.ic = 8.5
        self.paths = [
            "^/webcast/",
            "^/aweme/v1/",
            "^/aweme/v2/",
            "/v1/message/send",
            "^/live/",
            "^/captcha/",
            "^/ecom/",
        ]
        self.array1 = []  # Encrypted request body.
        self.array2 = []  # Encrypted request header, empty.
        self.array3 = []  # Encrypted UA.
        self.options = options  # GET [0, 1, 8] POST [0, 1, 14]
        self.ua_key = b"\x00\x01\x0E"  # UA encryption key.

        self.character = (
            "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe"
        )
        self.character2 = (
            "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe"
        )
        self.character_list = [self.character, self.character2]  # Custom Base64 alphabet.

        self.crypto_utility = CryptoUtility(
            self.salt, self.character_list
        )  # Encryption utility.

        self.user_agent = (
            user_agent
            if user_agent is not None and user_agent != ""
            else "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
        )  # Custom UA; if empty, set a default UA.

        self.browser_fp = (
            fp
            if fp is not None and fp != ""
            else BrowserFingerprintGenerator.generate_fingerprint("Edge")
        )  # Custom browser fingerprint; if empty, generate an Edge fingerprint.

        # fmt: off
        self.sort_index = [
            18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57, 39, 41, 43, 22, 28,
            32, 60, 36, 23, 29, 33, 37, 44, 45, 59, 46, 47, 48, 49, 50, 24, 25, 65, 66, 70, 71
        ]
        self.sort_index_2 = [
            18, 20, 26, 30, 34, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32, 36, 23, 29, 33, 37,
            44, 45, 46, 47, 48, 49, 50, 24, 25, 52, 53, 54, 55, 57, 58, 59, 60, 65, 66, 70, 71
        ]
        # fmt: on

    def encode_data(self, data: str, alphabet_index: int = 0) -> str:
        """
        Encode the data using the specified Base64 alphabet.

        Args:
            data (str): Input data.
            alphabet_index (int): Custom alphabet index.

        Returns:
            str: Encoded data.
        """
        return self.crypto_utility.abogus_encode(data, alphabet_index)

    def generate_abogus(self, params: str, body: str = "") -> tuple:
        """
        Generate the ABogus parameter.

        Args:
            params (str): Request parameters.
            body (str): Request body, empty for GET interfaces.

        Returns:
            tuple: ABogus parameter generated from params and UA.
        """
        ab_dir = {
            8: 3,  # Fixed.
            15: {
                "aid": self.aid,
                "pageId": self.pageId,
                "boe": self.boe,
                "ddrt": self.ddrt,
                "paths": self.paths,
                "track": {"mode": 0, "delay": 300, "paths": []},
                "dump": True,
                "rpU": "",
            },
            18: 44,
            19: [1, 0, 1, 0, 1],
            66: 0,  # Fixed.
            69: 0,  # Fixed.
            70: 0,  # Fixed.
            71: 0,  # Fixed.
        }

        # Encryption start time.
        start_encryption = int(time.time() * 1000)

        # Salt and encrypt params.
        array1 = self.crypto_utility.params_to_array(
            self.crypto_utility.params_to_array(params)
        )
        array2 = self.crypto_utility.params_to_array(
            self.crypto_utility.params_to_array(body)
        )
        array3 = self.crypto_utility.params_to_array(
            self.crypto_utility.base64_encode(
                StringProcessor.to_ord_str(
                    self.crypto_utility.rc4_encrypt(self.ua_key, self.user_agent)
                ),
                1,
            ),
            add_salt=False,
        )

        # Encryption end time.
        end_encryption = int(time.time() * 1000)

        # Insert encryption start time.
        ab_dir[20] = (start_encryption >> 24) & 255
        ab_dir[21] = (start_encryption >> 16) & 255
        ab_dir[22] = (start_encryption >> 8) & 255
        ab_dir[23] = start_encryption & 255
        ab_dir[24] = int(start_encryption / 256 / 256 / 256 / 256) >> 0
        ab_dir[25] = int(start_encryption / 256 / 256 / 256 / 256 / 256) >> 0

        # Insert request header configuration.
        ab_dir[26] = (self.options[0] >> 24) & 255
        ab_dir[27] = (self.options[0] >> 16) & 255
        ab_dir[28] = (self.options[0] >> 8) & 255
        ab_dir[29] = self.options[0] & 255

        # Insert request method.
        ab_dir[30] = int(self.options[1] / 256) & 255
        ab_dir[31] = (self.options[1] % 256) & 255
        ab_dir[32] = (self.options[1] >> 24) & 255
        ab_dir[33] = (self.options[1] >> 16) & 255

        # Insert request header encryption.
        ab_dir[34] = (self.options[2] >> 24) & 255
        ab_dir[35] = (self.options[2] >> 16) & 255
        ab_dir[36] = (self.options[2] >> 8) & 255
        ab_dir[37] = self.options[2] & 255

        # Insert request body encryption.
        ab_dir[38] = array1[21]
        ab_dir[39] = array1[22]
        # Insert body encryption.
        ab_dir[40] = array2[21]
        ab_dir[41] = array2[22]
        # Insert UA encryption.
        ab_dir[42] = array3[23]
        ab_dir[43] = array3[24]

        # Insert encryption end time.
        ab_dir[44] = (end_encryption >> 24) & 255
        ab_dir[45] = (end_encryption >> 16) & 255
        ab_dir[46] = (end_encryption >> 8) & 255
        ab_dir[47] = end_encryption & 255
        ab_dir[48] = ab_dir[8]
        ab_dir[49] = int(end_encryption / 256 / 256 / 256 / 256) >> 0
        ab_dir[50] = int(end_encryption / 256 / 256 / 256 / 256 / 256) >> 0

        # Insert fixed values.
        ab_dir[51] = (self.pageId >> 24) & 255
        ab_dir[52] = (self.pageId >> 16) & 255
        ab_dir[53] = (self.pageId >> 8) & 255
        ab_dir[54] = self.pageId & 255
        ab_dir[55] = self.pageId
        ab_dir[56] = self.aid
        ab_dir[57] = self.aid & 255
        ab_dir[58] = (self.aid >> 8) & 255
        ab_dir[59] = (self.aid >> 16) & 255
        ab_dir[60] = (self.aid >> 24) & 255

        # Insert browser fingerprint.
        ab_dir[64] = len(self.browser_fp)
        ab_dir[65] = len(self.browser_fp)

        # Get the sort_index values from ab_dir.
        sorted_values = [ab_dir.get(i, 0) for i in self.sort_index]

        # Convert the browser fingerprint to a list of ASCII codes.
        edge_fp_array = StringProcessor.to_char_array(self.browser_fp)

        # Use the low 8 bits of the browser fingerprint length as the XOR value.
        ab_xor = (len(self.browser_fp) & 255) >> 8 & 255

        # Perform the XOR calculation.
        for index in range(len(self.sort_index_2) - 1):
            if index == 0:
                ab_xor = ab_dir.get(self.sort_index_2[index], 0)
            ab_xor ^= ab_dir.get(self.sort_index_2[index + 1], 0)

        sorted_values.extend(edge_fp_array)
        sorted_values.append(ab_xor)

        abogus_bytes_str = (
            StringProcessor.generate_random_bytes()
            + self.crypto_utility.transform_bytes(sorted_values)
        )

        abogus = self.crypto_utility.abogus_encode(abogus_bytes_str, 0)
        params = "%s&a_bogus=%s" % (params, abogus)
        return (params, abogus, self.user_agent, body)


if __name__ == "__main__":
    # 24/06/16 Open-source custom UA later.
    # 24/07/08 Support custom UA and browser fingerprint.
    # 24/11/15 Completed the 1.0.1.19 ABogus algorithm, to be open-sourced later.
    # 25/03/05 Fix POST request parameter encryption errors and patch the environment.

    user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
    chrome_fp = BrowserFingerprintGenerator.generate_fingerprint("Edge")
    abogus = ABogus(user_agent=user_agent, fp=chrome_fp)

    # GET
    url = "https://www.douyin.com/aweme/v1/web/aweme/detail/?"
    params = "device_platform=webapp&aid=6383&channel=channel_pc_web&sec_user_id=MS4wLjABAAAArDVBosPJF3eIWVEFp0szuJ-e1V_-rK0ieJeWwpE77E8&max_cursor=0&locate_query=false&show_live_replay_strategy=1&need_time_list=1&time_list_query=0&whale_cut_token=&cut_version=1&count=18&publish_video_strategy_type=2&from_user_page=1&update_version_code=170400&pc_client_type=1&pc_libra_divert=Windows&support_h265=1&support_dash=0&version_code=290100&version_name=29.1.0&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Edge&browser_version=131.0.0.0&browser_online=true&engine_name=Blink&engine_version=131.0.0.0&os_name=Windows&os_version=10&cpu_core_num=12&device_memory=8&platform=PC&downlink=10&effective_type=4g&round_trip_time=50"
    body = ""
    print(url + abogus.generate_abogus(params=params, body=body)[0])

    # POST
    url = "https://www.douyin.com/aweme/v2/web/aweme/stats/?"
    params = "device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&pc_libra_divert=Windows&update_version_code=170400&support_h265=1&support_dash=0&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Edge&browser_version=131.0.0.0&browser_online=true&engine_name=Blink&engine_version=131.0.0.0&os_name=Windows&os_version=10&cpu_core_num=12&device_memory=8&platform=PC&downlink=10&effective_type=4g&round_trip_time=50"
    body = "aweme_type=0&item_id=7467485482314763572&play_delta=1&source=0"
    print(url + abogus.generate_abogus(params=params, body=body)[0])

    # # Test the time required to generate 100 ABogus parameters and 100 fingerprints.
    # start = time.time()
    # for _ in range(100):
    #     abogus.generate_abogus(params=params, body=body)
    # end = time.time()
    # print("Time required to generate 100 ABogus parameters and fingerprints:", end - start)  # Time required to generate 100 ABogus parameters and fingerprints: 2.203000783920288

    # start = time.time()
    # for _ in range(100):
    #     BrowserFingerprintGenerator.generate_fingerprint("Chrome")
    # end = time.time()
    # print("Time required to generate 100 fingerprints:", end - start)  # Time required to generate 100 fingerprints: 0.00400090217590332
