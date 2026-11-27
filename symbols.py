"""PDB discovery and validation for the profilers.

The tracker and the sampler resolve addresses to function names through dbghelp,
which only accepts a PDB whose GUID and age match the DLL byte for byte. A stale
PDB (the DLL was rebuilt, the PDB was not copied) would otherwise silently produce
wrong names, so this module checks the pair up front, in pure Python, and reports
one of: match / mismatch / missing / nodebug / error.

  * The DLL's debug directory holds a CodeView 'RSDS' record: GUID, age and the
    PDB path the linker wrote.
  * The PDB is an MSF container; stream 1 starts with (version, signature, age, GUID).
"""

import mmap
import os
import struct

PDB_MAGIC = b'Microsoft C/C++ MSF 7.00\r\n\x1aDS\x00\x00\x00'


def _guid_str(raw16):
    d1, d2, d3 = struct.unpack('<IHH', raw16[:8])
    return '%08X-%04X-%04X-%s-%s' % (d1, d2, d3, raw16[8:10].hex().upper(), raw16[10:16].hex().upper())


def read_codeview(dll_path):
    """-> dict(guid, age, pdb_path) from the DLL's debug directory, or None."""
    with open(dll_path, 'rb') as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            if mm[:2] != b'MZ':
                return None
            pe = struct.unpack_from('<I', mm, 0x3C)[0]
            if mm[pe:pe + 4] != b'PE\0\0':
                return None
            nsec, = struct.unpack_from('<H', mm, pe + 6)
            optsize, = struct.unpack_from('<H', mm, pe + 20)
            opt = pe + 24
            magic, = struct.unpack_from('<H', mm, opt)
            if magic == 0x20B:       # PE32+
                dd = opt + 112
            elif magic == 0x10B:     # PE32
                dd = opt + 96
            else:
                return None
            dbg_rva, dbg_size = struct.unpack_from('<II', mm, dd + 6 * 8)
            if not dbg_rva or not dbg_size:
                return None
            sec = opt + optsize
            sections = []
            for i in range(nsec):
                vsize, vaddr, rawsize, rawptr = struct.unpack_from('<IIII', mm, sec + i * 40 + 8)
                sections.append((vaddr, max(vsize, rawsize), rawptr))

            def rva_to_off(rva):
                for vaddr, size, rawptr in sections:
                    if vaddr <= rva < vaddr + size:
                        return rawptr + (rva - vaddr)
                return None

            off = rva_to_off(dbg_rva)
            if off is None:
                return None
            for i in range(dbg_size // 28):
                (_, _, _, _, typ, size, _, ptr) = struct.unpack_from('<IIHHIIII', mm, off + i * 28)
                if typ != 2 or size < 24:     # IMAGE_DEBUG_TYPE_CODEVIEW
                    continue
                if mm[ptr:ptr + 4] != b'RSDS':
                    continue
                guid = _guid_str(mm[ptr + 4:ptr + 20])
                age, = struct.unpack_from('<I', mm, ptr + 20)
                end = mm.find(b'\0', ptr + 24, ptr + size)
                path = mm[ptr + 24:end if end >= 0 else ptr + size].decode('utf-8', 'replace')
                return {'guid': guid, 'age': age, 'pdb_path': path}
            return None
        finally:
            mm.close()


def read_pdb_signature(pdb_path):
    """-> dict(guid, age) from a PDB's info stream (MSF 7.0), or None."""
    with open(pdb_path, 'rb') as f:
        head = f.read(56)
        if head[:32] != PDB_MAGIC:
            return None
        block, _free, nblocks, dir_bytes, _unk, map_addr = struct.unpack_from('<6I', head, 32)
        if block not in (512, 1024, 2048, 4096, 8192):
            return None
        ndir_blocks = (dir_bytes + block - 1) // block
        f.seek(map_addr * block)
        dir_block_ids = struct.unpack('<%dI' % ndir_blocks, f.read(4 * ndir_blocks))
        directory = bytearray()
        for b in dir_block_ids:
            f.seek(b * block)
            directory += f.read(block)
        directory = bytes(directory[:dir_bytes])
        nstreams, = struct.unpack_from('<I', directory, 0)
        sizes = struct.unpack_from('<%dI' % nstreams, directory, 4)
        pos = 4 + 4 * nstreams
        # Stream 1 is the PDB info stream: skip the block lists of stream 0.
        s0 = 0 if sizes[0] == 0xFFFFFFFF else (sizes[0] + block - 1) // block
        pos += 4 * s0
        if nstreams < 2 or sizes[1] == 0xFFFFFFFF or sizes[1] < 28:
            return None
        first_block, = struct.unpack_from('<I', directory, pos)
        f.seek(first_block * block)
        info = f.read(28)
        _ver, _sig, age = struct.unpack_from('<III', info, 0)
        return {'guid': _guid_str(info[12:28]), 'age': age}


def _candidates(dll_path, pdb_hint, expected_name, embedded_path):
    dll_dir = os.path.dirname(os.path.abspath(dll_path))
    stem = os.path.splitext(os.path.basename(dll_path))[0]
    names = []
    for n in (expected_name, stem + '.pdb'):
        if n and n.lower() not in [x.lower() for x in names]:
            names.append(n)
    out = []
    hint = (pdb_hint or '').strip().strip('"')
    if hint:
        if os.path.isdir(hint):
            out += [os.path.join(hint, n) for n in names]
        else:
            out.append(hint)
    out += [os.path.join(dll_dir, n) for n in names]
    if embedded_path:
        out.append(embedded_path)
    seen, uniq = set(), []
    for p in out:
        k = os.path.normcase(os.path.abspath(p))
        if k not in seen:
            seen.add(k)
            uniq.append(p)
    return uniq


def check_symbols(dll_path, pdb_hint=''):
    """Validate the DLL/PDB pair. Always returns a dict with a 'state' key:

    match     a PDB with the DLL's GUID was found -> names will resolve
    mismatch  a PDB was found but belongs to a different build of the DLL
    missing   no PDB file located (the DLL does reference one)
    nodebug   the DLL carries no CodeView debug record (no PDB was ever linked)
    error     the DLL could not be read
    'symbol_path' is the semicolon-joined folder list to hand to dbghelp.
    """
    res = {'state': 'error', 'message': '', 'pdb': '', 'expected_pdb': '', 'guid': '',
           'age': None, 'pdb_age': None, 'symbol_path': '', 'checked': []}
    try:
        if not dll_path or not os.path.isfile(dll_path):
            res['message'] = 'DLL file not found'
            return res
        cv = read_codeview(dll_path)
    except Exception as e:      # unreadable / not a PE
        res['message'] = 'Could not read the DLL debug info: %s' % e
        return res

    dll_dir = os.path.dirname(os.path.abspath(dll_path))
    if cv is None:
        res['state'] = 'nodebug'
        res['message'] = ('The DLL has no debug directory. Link with /DEBUG (Release builds '
                          'too) to produce a PDB.')
        res['symbol_path'] = dll_dir
        return res

    expected = os.path.basename(cv['pdb_path'].replace('\\', '/'))
    res.update({'guid': cv['guid'], 'age': cv['age'], 'expected_pdb': expected})
    found_other = None
    for cand in _candidates(dll_path, pdb_hint, expected, cv['pdb_path']):
        res['checked'].append(cand)
        if not os.path.isfile(cand):
            continue
        try:
            sig = read_pdb_signature(cand)
        except Exception:
            sig = None
        if sig is None:
            found_other = found_other or (cand, None)
            continue
        if sig['guid'] == cv['guid']:
            res['pdb'] = cand
            res['pdb_age'] = sig['age']
            if os.path.basename(cand).lower() != expected.lower():
                res['state'] = 'mismatch'
                res['message'] = ('This PDB matches the DLL but is named %s; the DLL references %s. '
                                  'dbghelp looks it up by that name - rename or copy the file.'
                                  % (os.path.basename(cand), expected))
                res['symbol_path'] = dll_dir
                return res
            res['state'] = 'match'
            res['message'] = 'PDB matches the DLL build (GUID %s).' % cv['guid']
            if sig['age'] != cv['age']:
                res['message'] += (' Age differs (DLL %s, PDB %s); names usually still resolve.'
                                   % (cv['age'], sig['age']))
            dirs = [os.path.dirname(os.path.abspath(cand)), dll_dir]
            res['symbol_path'] = ';'.join(dict.fromkeys(dirs))
            return res
        found_other = found_other or (cand, sig)

    if found_other:
        res['state'] = 'mismatch'
        res['pdb'] = found_other[0]
        if found_other[1]:
            res['pdb_age'] = found_other[1]['age']
            res['message'] = ('%s belongs to a different build (PDB GUID %s, DLL expects %s). '
                              'Rebuild so the DLL and PDB come from the same link.'
                              % (os.path.basename(found_other[0]), found_other[1]['guid'], cv['guid']))
        else:
            res['message'] = '%s is not a readable PDB (MSF 7.0).' % os.path.basename(found_other[0])
        res['symbol_path'] = dll_dir
        return res

    res['state'] = 'missing'
    res['message'] = ('No %s found next to the DLL or at the linked path. Pick the PDB with Browse '
                      'or type its folder.' % expected)
    res['symbol_path'] = dll_dir
    return res
