import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  diffDays,
  eachDay,
  endOfMonth,
  isCivilDate,
  isoWeekday,
  nowTimeInZone,
  startOfWeek,
  todayInZone,
} from '../../src/domain/civil';
import { convertWallTime, instantToWallTime, isValidTimeZone, msUntilNextMidnight, wallTimeToInstant } from '../../src/domain/tz';

describe('datas civis', () => {
  it('valida datas reais', () => {
    expect(isCivilDate('2026-10-17')).toBe(true);
    expect(isCivilDate('2028-02-29')).toBe(true);
    expect(isCivilDate('2026-02-29')).toBe(false);
    expect(isCivilDate('2026-13-01')).toBe(false);
    expect(isCivilDate('17/10/2026')).toBe(false);
  });

  it('soma dias atravessando mês, ano e ano bissexto', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-11-01', '2026-10-17')).toBe(15);
    expect(eachDay('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(eachDay('2026-11-02', '2026-10-30')).toEqual([]);
  });

  it('calcula dia da semana ISO e início de semana', () => {
    expect(isoWeekday('2026-10-17')).toBe(6); // sábado
    expect(isoWeekday('2026-10-18')).toBe(7); // domingo
    expect(isoWeekday('2026-10-19')).toBe(1); // segunda
    expect(startOfWeek('2026-10-17', 1)).toBe('2026-10-12');
    expect(startOfWeek('2026-10-17', 0)).toBe('2026-10-11');
    expect(startOfWeek('2026-10-18', 1)).toBe('2026-10-12');
    expect(startOfWeek('2026-10-18', 0)).toBe('2026-10-18');
  });

  it('lida com fim de mês e soma de meses', () => {
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('descobre "hoje" no fuso do perfil, não no do sistema', () => {
    const instant = new Date('2026-10-18T02:30:00Z'); // 23:30 em São Paulo; 03:30 em Lisboa (UTC+1)
    expect(todayInZone('America/Sao_Paulo', instant)).toBe('2026-10-17');
    expect(todayInZone('Europe/Lisbon', instant)).toBe('2026-10-18');
    expect(nowTimeInZone('America/Sao_Paulo', instant)).toBe('23:30');
    expect(nowTimeInZone('Asia/Tokyo', instant)).toBe('11:30');
  });
});

describe('fusos e horário de verão', () => {
  it('valida fusos IANA', () => {
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('mantém o horário de parede de eventos semanais através da mudança de horário', () => {
    // Nova York: horário de verão começa em 08/03/2026 e termina em 01/11/2026.
    expect(wallTimeToInstant('2026-03-07', '09:00', 'America/New_York').toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(wallTimeToInstant('2026-03-09', '09:00', 'America/New_York').toISOString()).toBe('2026-03-09T13:00:00.000Z');
    expect(wallTimeToInstant('2026-10-31', '09:00', 'America/New_York').toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(wallTimeToInstant('2026-11-02', '09:00', 'America/New_York').toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('avança horários inexistentes no salto do relógio', () => {
    const inst = wallTimeToInstant('2026-03-08', '02:30', 'America/New_York');
    expect(instantToWallTime(inst, 'America/New_York')).toEqual({ date: '2026-03-08', time: '03:30' });
  });

  it('converte horário de parede entre fusos, inclusive mudando a data', () => {
    expect(convertWallTime('2026-10-17', '22:30', 'America/Sao_Paulo', 'Europe/Lisbon')).toEqual({ date: '2026-10-18', time: '02:30' });
    // Depois de 25/10/2026 Lisboa volta a UTC+0.
    expect(convertWallTime('2026-10-27', '22:30', 'America/Sao_Paulo', 'Europe/Lisbon')).toEqual({ date: '2026-10-28', time: '01:30' });
    expect(convertWallTime('2026-10-17', '10:00', 'UTC', 'UTC')).toEqual({ date: '2026-10-17', time: '10:00' });
  });

  it('calcula o tempo até a próxima meia-noite local, inclusive em dia de 23 horas', () => {
    expect(msUntilNextMidnight('America/Sao_Paulo', new Date('2026-10-18T02:00:00Z'))).toBe(60 * 60 * 1000); // 23:00 → 00:00
    // 08/03/2026 em Nova York tem 23h: de 00:00 até a meia-noite seguinte.
    expect(msUntilNextMidnight('America/New_York', new Date('2026-03-08T05:00:00Z'))).toBe(23 * 60 * 60 * 1000);
  });
});
